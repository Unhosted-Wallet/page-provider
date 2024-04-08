# @unhosted-wallet/page-provider

## Setup

```sh
npm i
npm run build
```

## Purpose

The generated dist/index.js file is meant to be injected in a Chrome Extension project. Loading it will set the `window.ethereum` object in every page (except for a select few). Will bind certain specific events prefixed with `unhosted:` (search throughout the project to find them) to certain RPC actions (connect, sign, transfer, etc).

And finally, it adds 6963 on top to allow the user to have multiple wallets in their browser without experiencing issues. Note that the dApps users use will also need to have proper compatibility with it (most do).

see [Rabby Wallet explanation](https://github.com/RabbyHub/Rabby?tab=readme-ov-file#--pageproviderjs) for more detail

## Technical detail

This repo is intended to be used as a dependency for the Chrome Extension project, add to package.json's dependencies like this:

```json
{
    "dependencies": {
        "@unhosted/page-provider": "git+ssh://git@github.com:Unhosted-Wallet/page-provider.git"
    }
}
```

and it should then be required in webpack config like this:

```js
entry: {
    pageProvider: paths.rootResolve(
        "node_modules/@unhosted-wallet/page-provider/dist/index.js"
    ),
}
```

and finally, injected like this in the `content-script`:

```js
const injectProviderScript = (isDefaultWallet: boolean) => {
  // the script element with src won't execute immediately
  // use inline script element instead!
  const container = document.head || document.documentElement;
  const ele = document.createElement('script');
  // in prevent of webpack optimized code do some magic(e.g. double/sigle quote wrap),
  // separate content assignment to two line
  // use AssetReplacePlugin to replace pageprovider content
  ele.setAttribute('src', chrome.runtime.getURL('pageProvider.js'));
  container.insertBefore(ele, container.children[0]);
  container.removeChild(ele);
};
```