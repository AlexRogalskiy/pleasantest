import aliasPlugin from '@rollup/plugin-alias';
import { babel } from '@rollup/plugin-babel';
import { makeCallableJSHandle, withBrowser } from 'pleasantest';
import type { PleasantestContext, PleasantestUtils } from 'pleasantest';
import sveltePlugin from 'rollup-plugin-svelte';
import vuePlugin from 'rollup-plugin-vue';
import sveltePreprocess from 'svelte-preprocess';

import { formatErrorWithCodeFrame, printErrorFrames } from '../test-utils.js';

const createHeading = async ({
  utils,
  screen,
}: {
  utils: PleasantestUtils;
  screen: PleasantestContext['screen'];
}) => {
  await utils.injectHTML(`
    <h1>I'm a heading</h1>
  `);

  return screen.getByRole('heading', { name: /i'm a heading/i });
};

test(
  'basic inline code',
  withBrowser(async ({ utils, screen }) => {
    const heading = await createHeading({ utils, screen });

    await expect(heading).toBeInTheDocument();

    await utils.runJS(`
      const heading = document.querySelector('h1')
      heading.remove()
    `);

    await expect(heading).not.toBeInTheDocument();
  }),
);

test(
  'allows passing functions to runJS',
  withBrowser(async ({ utils }) => {
    const mockFuncA = jest.fn(() => 5);
    const mockFuncB = jest.fn();

    await utils.runJS(
      `
      const [mockFuncA, mockFuncB] = import.meta.pleasantestArgs;
      const val = await mockFuncA('hello world');
      if (val !== 5) throw new Error('Did not get return value');
      await mockFuncB()
      `,
      [mockFuncA, mockFuncB],
    );

    expect(mockFuncA).toHaveBeenCalledTimes(1);
    expect(mockFuncA.mock.calls).toMatchInlineSnapshot(`
      [
        [
          "hello world",
        ],
      ]
    `);
    expect(mockFuncB).toHaveBeenCalledTimes(1);
    expect(mockFuncB.mock.calls).toMatchInlineSnapshot(`
      [
        [],
      ]
    `);
  }),
);

test(
  'allows passing ElementHandles and serializable values into browser',
  withBrowser(async ({ utils, screen }) => {
    const heading = await createHeading({ utils, screen });
    await utils.runJS(
      `
      const [heading, object] = import.meta.pleasantestArgs
      if (heading.outerHTML !== "<h1>I'm a heading</h1>") {
        throw new Error('element was not passed correctly')
      }
      if (object.some.serializable.value !== false) {
        throw new Error('object was not passed correctly')
      }
      `,
      [heading, { some: { serializable: { value: false } } }],
    );
  }),
);

describe('Waiting for Promises in executed code', () => {
  it(
    'should not wait for non-exported promises',
    withBrowser(async ({ utils, screen }) => {
      const heading = await createHeading({ utils, screen });

      await expect(heading).toBeInTheDocument();

      await utils.runJS(`
        const heading = document.querySelector('h1')

        new Promise(r => setTimeout(r, 50))
          .then(() => heading.remove())
      `);

      // Since it didn't wait for the promise
      await expect(heading).toBeInTheDocument();
    }),
  );
  it(
    'should wait for top-level-await',
    withBrowser(async ({ utils, screen }) => {
      const heading = await createHeading({ utils, screen });

      await expect(heading).toBeInTheDocument();

      await utils.runJS(`
        const heading = document.querySelector('h1')

        await new Promise(r => setTimeout(r, 50))
          .then(() => heading.remove())
      `);
      await expect(heading).not.toBeInTheDocument();
    }),
  );
});

test(
  'runJS returns exported values, and allows calling returned functions',
  withBrowser(async ({ utils }) => {
    const result = await utils.runJS<{
      a: number;
      default: string;
      b: (
        arg1: number,
        arg2: { test: 'object' },
      ) => ['it worked', typeof arg1, typeof arg2];
    }>(`
      export const a = 25;
      export default "hi"
      export const b = (arg1, arg2) => {
        return ['it worked!', arg1, arg2]
      }
    `);
    expect(Object.keys(result).sort()).toStrictEqual(['a', 'b', 'default']);
    expect(result.a.toString()).toEqual('JSHandle:25');
    expect(result.b.toString()).toEqual('JSHandle@function');
    expect(result.default.toString()).toEqual('JSHandle:hi');

    expect(await result.a.jsonValue()).toStrictEqual(25);
    expect(await result.b.jsonValue()).toStrictEqual({}); // function is not JSON-serializable
    expect(await result.default.jsonValue()).toStrictEqual('hi');

    const b = makeCallableJSHandle(result.b);
    const callResult = await b(37, { test: 'object' });

    expect(callResult.toString()).toEqual('JSHandle@array');
    expect(await callResult.jsonValue()).toStrictEqual([
      'it worked!',
      37,
      { test: 'object' },
    ]);
  }),
);

test(
  'supports TS in snippet',
  withBrowser(async ({ utils, screen }) => {
    const heading = await createHeading({ utils, screen });

    await expect(heading).toBeInTheDocument();

    // Note: the snippet inherits the language support from the test file that includes it
    // So since this file is a .ts file, the snippet supports TS syntax
    await utils.runJS(`
      type foo = 'stringliteraltype'
      document.querySelector('h1').remove()
    `);
    await expect(heading).not.toBeInTheDocument();
  }),
);

test(
  'throws error with real source-mapped location',
  withBrowser(async ({ utils }) => {
    // Manually-thrown error
    const error = await utils
      .runJS(
        `type foo = 'stringliteraltype'
        throw new Error('errorFromTs')`,
      )
      .catch((error) => error);

    expect(await printErrorFrames(error)).toMatchInlineSnapshot(`
      "Error: errorFromTs
      -------------------------------------------------------
      tests/utils/runJS.test.tsx

              throw new Error('errorFromTs')\`,
                    ^"
    `);

    // Implicitly created error
    const error2 = await utils
      .runJS(
        `type foo = 'stringliteraltype'
        thisVariableDoesntExist`,
      )
      .catch((error) => error);

    expect(await printErrorFrames(error2)).toMatchInlineSnapshot(`
      "ReferenceError: thisVariableDoesntExist is not defined
      -------------------------------------------------------
      tests/utils/runJS.test.tsx

              thisVariableDoesntExist\`,
              ^"
    `);
  }),
);

test(
  'Imports by different runJS calls point to the same values',
  withBrowser(async ({ utils }) => {
    await utils.runJS(`
      import { render } from 'preact'
      window.__preact_render = render
    `);
    await utils.runJS(`
      import { render } from 'preact'
      if (window.__preact_render !== render)
        throw new Error('Importing the same thing multiple times resulted in different modules')
    `);
  }),
);

test(
  "TransformImports throws stack frame if it can't parse the input",
  withBrowser(
    // Disable esbuild so that the invalid code will get through to the import transformer
    { moduleServer: { esbuild: false } },
    async ({ utils }) => {
      const runPromise = utils.runJS(`
        asdf())
      `);

      await expect(formatErrorWithCodeFrame(runPromise)).rejects
        .toThrowErrorMatchingInlineSnapshot(`
          "Error parsing module with es-module-lexer.

          <root>/tests/utils/runJS.test.tsx:###:###

            ### |     async ({ utils }) => {
            ### |       const runPromise = utils.runJS(\`
          > ### |         asdf())
                |               ^
            ### |       \`);
            ### | 
            ### |       await expect(formatErrorWithCodeFrame(runPromise)).rejects
          "
        `);
    },
  ),
);

test(
  'Line/column offsets for source-mapped runtime error is correct even with esbuild disabled',
  withBrowser({ moduleServer: { esbuild: false } }, async ({ utils }) => {
    const error = await utils
      .runJS('console.log(nothing)')
      .catch((error) => error);
    expect(await printErrorFrames(error)).toMatchInlineSnapshot(`
      "ReferenceError: nothing is not defined
      -------------------------------------------------------
      tests/utils/runJS.test.tsx

            .runJS('console.log(nothing)')
                                ^"
    `);
  }),
);

test(
  'allows importing .tsx file, and errors from imported file are source mapped',
  withBrowser(async ({ utils, page }) => {
    await utils.runJS(`
      import { render } from './external'
      render()
    `);

    expect(
      await page.evaluate(() => document.body.innerHTML.trim()),
    ).toMatchInlineSnapshot(`"<h1 style="">Hi</h1>"`);

    await utils.injectHTML('');

    const error = await utils
      .runJS(
        `import { renderThrow } from './external'
        renderThrow()`,
      )
      .catch((error) => error);

    expect(await printErrorFrames(error)).toMatchInlineSnapshot(`
      "Error: you have rendered the death component
      -------------------------------------------------------
      tests/utils/external.tsx

        throw new Error('you have rendered the death component');
              ^
      -------------------------------------------------------
      tests/utils/external.tsx

        preactRender(<ThrowComponent />, document.body);
        ^
      -------------------------------------------------------
      tests/utils/runJS.test.tsx

              renderThrow()\`,
              ^"
    `);
  }),
);

test(
  'If the code string has a syntax error the location is source mapped',
  withBrowser(async ({ utils }) => {
    const runPromise = utils.runJS(`
      console.log('hi'))
    `);

    await expect(formatErrorWithCodeFrame(runPromise)).rejects
      .toThrowErrorMatchingInlineSnapshot(`
      "[esbuild] Expected ";" but found ")"

      <root>/tests/utils/runJS.test.tsx:###:###

        ### |   withBrowser(async ({ utils }) => {
        ### |     const runPromise = utils.runJS(\`
      > ### |       console.log('hi'))
            |                        ^
        ### |     \`);
        ### | 
        ### |     await expect(formatErrorWithCodeFrame(runPromise)).rejects
      "
    `);
  }),
);

test(
  'If an imported file has a syntax error the location is source mapped',
  withBrowser(async ({ utils }) => {
    const runPromise = utils.runJS(`
      import './external-with-syntax-error'
    `);

    await expect(formatErrorWithCodeFrame(runPromise)).rejects
      .toThrowErrorMatchingInlineSnapshot(`
      "[esbuild] The constant "someVariable" must be initialized

      <root>/tests/utils/external-with-syntax-error.ts:###:###

        # | // @ts-expect-error: this is intentionally invalid
      > # | const someVariable: string;
          |       ^
        # | 
      "
    `);
  }),
);

test(
  'resolution error if a package does not exist in node_modules',
  withBrowser(async ({ utils }) => {
    const runPromise = formatErrorWithCodeFrame(
      utils.runJS(`
        import 'something-not-existing'
      `),
    );

    await expect(runPromise).rejects.toThrowErrorMatchingInlineSnapshot(
      `"Could not find something-not-existing in node_modules (imported by <root>/tests/utils/runJS.test.tsx:###:###)"`,
    );
  }),
);

test(
  'resolution error if a relative path does not exist',
  withBrowser(async ({ utils }) => {
    const runPromise = utils.runJS(`
      import './bad-relative-path'
    `);

    await expect(
      formatErrorWithCodeFrame(runPromise),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `"Could not resolve ./bad-relative-path (imported by <root>/tests/utils/runJS.test.tsx:###:###)"`,
    );
  }),
);

test(
  'Allows importing CSS into JS file',
  withBrowser(async ({ utils, screen }) => {
    await utils.injectHTML('<h1>This is a heading</h1>');
    const heading = await screen.getByRole('heading');
    await expect(heading).toBeVisible();
    await utils.runJS(`
      import './external.sass'
    `);
    await expect(heading).not.toBeVisible();
  }),
);

describe('Ecosystem interoperability', () => {
  test(
    'Named exports implicitly created from default-only export in CJS',
    withBrowser(async ({ utils }) => {
      // Prop-types is CJS and provides non-statically-analyzable named exports
      await utils.runJS(`
        import { number } from 'prop-types'
        import PropTypes from 'prop-types'
        if (number !== PropTypes.number) {
          throw new Error('Named import did not yield same result as default import')
        }
        PropTypes.checkPropTypes(
          { name: number },
          { name: 5 },
        );
      `);
    }),
  );
  test(
    'react and react-dom can be imported, and JSX works',
    withBrowser(async ({ utils, screen }) => {
      await utils.runJS(`
        import * as React from 'react'
        import React2 from 'react'
        if (React.createElement !== React2.createElement) {
          throw new Error('Namespace import did not yield same result as direct import')
        }
        import { createRoot } from 'react-dom/client';

        const container = document.createElement('div')
        document.body.innerHTML = ''
        document.body.append(container)
        const root = createRoot(container)
        root.render(<h1>Hi</h1>)
      `);
      const heading = await screen.getByRole('heading');
      await expect(heading).toHaveTextContent('Hi');
    }),
  );
  test(
    'vue component can be imported via rollup-plugin-vue',
    withBrowser(
      {
        moduleServer: {
          plugins: [
            {
              name: 'replace-for-vue',
              transform(code) {
                return code
                  .replace(/__VUE_OPTIONS_API__/g, 'true')
                  .replace(/__VUE_PROD_DEVTOOLS__/g, 'false');
              },
            },
            vuePlugin(),
          ],
        },
      },
      async ({ utils, screen }) => {
        await utils.injectHTML('<div id="app"></div>');
        await utils.runJS(`
          import { createApp } from 'vue'
          import VueComponent from './vue-component.vue'
          const app = createApp(VueComponent)
          app.mount('#app')
        `);
        const heading = await screen.getByRole('heading');
        await expect(heading).toHaveTextContent('Hiya');
        await expect(heading).toHaveStyle({ color: 'green' });
      },
    ),
  );
  test(
    'svelte component can be imported via rollup-plugin-svelte',
    withBrowser(
      {
        moduleServer: {
          plugins: [
            sveltePlugin({
              preprocess: sveltePreprocess({
                // Does not work with module set to nodenext, works with either commonjs or esnext
                typescript: { compilerOptions: { module: 'commonjs' } },
              }),
            }),
          ],
        },
      },
      async ({ utils, screen, user }) => {
        await utils.injectHTML('<div id="app"></div>');
        await utils.runJS(`
          import CounterComponent from './svelte-component.svelte'

          new CounterComponent({
            target: document.getElementById('app')
          })
        `);
        const button = await screen.getByRole('button');
        await expect(button).toHaveTextContent(/^clicked 0 times$/i);

        await user.click(button);
        await expect(button).toHaveTextContent(/^clicked 1 time$/i);

        // Check that the scss in the svelte component file got preprocessed and applied correctly
        const bgColor = await button.evaluate(
          (button) => getComputedStyle(button).backgroundColor,
        );
        expect(bgColor).toEqual('rgb(255, 0, 0)');
      },
    ),
  );
  test(
    'useful error message is thrown when plugin is missing for imported file with unusual extension',
    withBrowser(async ({ utils }) => {
      const runPromise = utils.runJS(`
        import CounterComponent from './svelte-component.svelte'
        window._ = CounterComponent; // so that the import does not get removed by TS transpilation
      `);

      await expect(formatErrorWithCodeFrame(runPromise)).rejects
        .toThrowErrorMatchingInlineSnapshot(`
          "Error parsing module with es-module-lexer. Did you mean to add a transform plugin to support .svelte files?

          <root>/tests/utils/svelte-component.svelte:###:###

             # |     count += 1;
             # |   }
          >  # | </script>
               |          ^
             # | 
            ## | <button on:click={handleClick}>
            ## |   Clicked {count} {count === 1 ? 'time' : 'times'}
          "
        `);
    }),
  );
});

test(
  'can use @rollup/plugin-alias',
  withBrowser(
    {
      moduleServer: {
        plugins: [
          aliasPlugin({
            entries: { asdf: 'preact', foo: './external' },
          }),
        ],
      },
    },
    async ({ utils }) => {
      await utils.runJS(`
        import * as preact from 'asdf'
        if (!preact.h || !preact.Fragment || !preact.Component)
          throw new Error('Alias did not load preact correctly')
        import * as external from 'foo'
        if (!external.render || !external.renderThrow)
          throw new Error('Alias did not load ./external.tsx correctly')
      `);
    },
  ),
);

test(
  'environment variables are injected into browser code',
  withBrowser(
    {
      moduleServer: {
        envVars: { asdf: '1234' },
      },
    },
    async ({ utils }) => {
      await utils.runJS(`
        if (process.env.NODE_ENV !== 'development')
          throw new Error('process.env.NODE_ENV not set correctly')
        if (import.meta.env.NODE_ENV !== 'development')
          throw new Error('import.meta.env.NODE_ENV not set correctly')
        if (process.env.asdf !== '1234')
          throw new Error('process.env.asdf not set correctly')
        if (import.meta.env.asdf !== '1234')
          throw new Error('import.meta.env.asdf not set correctly')
      `);
    },
  ),
);

test(
  '@rollup/plugin-babel works',
  withBrowser(
    {
      moduleServer: {
        esbuild: false,
        plugins: [
          babel({
            extensions: ['.js', '.ts', '.tsx', '.mjs'],
            babelHelpers: 'bundled',
            presets: ['@babel/preset-typescript'],
          }),
        ],
      },
    },
    async ({ utils }) => {
      await utils.runJS("const foo: string = 'hello'");

      // Check that source map from babel works correctly
      const error = await utils
        .runJS('console.log(nothing)')
        .catch((error) => error);
      expect(await printErrorFrames(error)).toMatchInlineSnapshot(`
        "ReferenceError: nothing is not defined
        -------------------------------------------------------
        tests/utils/runJS.test.tsx

              .runJS('console.log(nothing)')
                                  ^"
      `);
    },
  ),
);
