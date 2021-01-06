import { port } from '.';

const methods = [
  'toBeInTheDOM',
  'toBeInTheDocument',
  'toBeEmpty',
  'toBeEmptyDOMElement',
  'toContainElement',
  'toContainHTML',
  'toHaveTextContent',
  'toHaveAttribute',
  'toHaveClass',
  'toHaveStyle',
  'toHaveFocus',
  'toHaveFormValues',
  'toBeVisible',
  'toBeDisabled',
  'toBeEnabled',
  'toBeRequired',
  'toBeInvalid',
  'toBeValid',
  'toHaveValue',
  'toHaveDisplayValue',
  'toBeChecked',
  'toBePartiallyChecked',
  'toHaveDescription',
];

expect.extend(
  Object.fromEntries(
    methods.map((methodName) => {
      const matcher = async function (
        this: unknown,
        elementHandle: import('puppeteer').ElementHandle,
      ) {
        const ctxString = JSON.stringify(this); // contains stuff like isNot and promise
        const result = await elementHandle.evaluateHandle(
          // using new Function to avoid babel transpiling the import
          // @ts-ignore
          new Function(
            'element',
            `return import("http://localhost:${port}/@test-mule/jest-dom").then(jestDom => {
              const context = { ...(${ctxString}), ...jestDom.jestContext }
              const result = jestDom.${methodName}.call(context, element)
              if (result.pass === context.isNot) {
                window.__testMuleDebug__ = true
                const simplifiedMessage = result
                  .message()
                  .replace(/\\$\\$JEST_UTILS\\$\\$\\.([a-zA-Z]*)\\((.*?)\\)/g, '');
                console.error('matcher failed:', simplifiedMessage.trim() + '\\n', element)
              }
              return result
            })`,
          ),
          // the __testMuleDebug__ thing is a flag that is set in the browser global when the test fails
          // to keep the tab open (afterAll checks for the flag before it closes tabs)
          elementHandle,
        );
        // @ts-expect-error it is used but for some reason ts doesn't recognize
        const message = await result
          .evaluateHandle((matcherResult) => matcherResult.message())
          .then((m) => m.jsonValue());
        const final = {
          // @ts-ignore
          ...(await result.jsonValue()),
          message: () => deserialize(message, this),
        };

        return final;
      };
      return [methodName, matcher];
    }),
  ),
);

// @ts-expect-error it is used but for some reason ts doesn't recognize
const deserialize = (message: string, context: jest.MatcherContext) => {
  return message.replace(
    /\$\$JEST_UTILS\$\$\.([a-zA-Z]*)\((.*?)\)/g,
    (_match, funcName, args) => {
      // @ts-expect-error
      return context.utils[funcName](...JSON.parse(args, reviver));
    },
  );
};

function reviver(_key: string, value: unknown) {
  // @ts-ignore
  if (typeof value === 'object' && value.__serialized === 'HTMLElement') {
    const wrapper = document.createElement('div');
    // @ts-ignore
    wrapper.innerHTML = value.outerHTML;
    return wrapper.firstElementChild;
  }
  return value;
}

// These type definitions are incomplete
// More can be added from https://unpkg.com/@types/testing-library__jest-dom/index.d.ts
// You can copy-paste and change the return types to promises
declare global {
  namespace jest {
    interface Matchers<R> {
      /**
       * Check if an element is currently visible to the user.
       * https://github.com/testing-library/jest-dom#tobevisible
       */
      toBeVisible(): Promise<R>;
    }
  }
}