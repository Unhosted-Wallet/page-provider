// this script is injected into webpage's context
import { ethErrors, serializeError } from "eth-rpc-errors";
import { EventEmitter } from "events";
import iconb64 from "./iconb64";
import DedupePromise from "./pageProvider/dedupePromise";
import { switchChainNotice } from "./pageProvider/interceptors/switchChain";
import { switchWalletNotice } from "./pageProvider/interceptors/switchWallet";
import PushEventHandlers from "./pageProvider/pushEventHandlers";
import ReadyPromise from "./pageProvider/readyPromise";
import { $, domReadyCall } from "./pageProvider/utils";
import BroadcastChannelMessage from "./utils/message/broadcastChannelMessage";
import { patchProvider } from "./utils/metamask";

declare const __unhosted__channelName;
declare const __unhosted__isDefaultWallet;
declare const __unhosted__uuid;
declare const __unhosted__isOpera;

const log = (event, ...args) => {
  if (process.env.NODE_ENV !== "production") {
    console.log(
      `%c [unhosted] (${new Date().toTimeString().substr(0, 8)}) ${event}`,
      "font-weight: bold; background-color: #7d6ef9; color: white;",
      ...args
    );
  }
};

let channelName =
  typeof __unhosted__channelName !== "undefined" ? __unhosted__channelName : "";
let isDefaultWallet =
  typeof __unhosted__isDefaultWallet !== "undefined"
    ? __unhosted__isDefaultWallet
    : false;
let isOpera =
  typeof __unhosted__isOpera !== "undefined" ? __unhosted__isOpera : false;
let uuid = typeof __unhosted__uuid !== "undefined" ? __unhosted__uuid : "";

const getParams = () => {
  if (localStorage.getItem("unhosted:channelName")) {
    channelName = localStorage.getItem("unhosted:channelName") as string;
    localStorage.removeItem("unhosted:channelName");
  }
  if (localStorage.getItem("unhosted:isDefaultWallet")) {
    isDefaultWallet =
      localStorage.getItem("unhosted:isDefaultWallet") === "true";
    localStorage.removeItem("unhosted:isDefaultWallet");
  }
  if (localStorage.getItem("unhosted:uuid")) {
    uuid = localStorage.getItem("unhosted:uuid") as string;
    localStorage.removeItem("unhosted:uuid");
  }
  if (localStorage.getItem("unhosted:isOpera")) {
    isOpera = localStorage.getItem("unhosted:isOpera") === "true";
    localStorage.removeItem("unhosted:isOpera");
  }
};
getParams();

export interface Interceptor {
  onRequest?: (data: any) => any;
  onResponse?: (res: any, data: any) => any;
}

interface StateProvider {
  accounts: string[] | null;
  isConnected: boolean;
  isUnlocked: boolean;
  initialized: boolean;
  isPermanentlyDisconnected: boolean;
}

interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}
interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: EthereumProvider;
}

interface EIP6963AnnounceProviderEvent extends CustomEvent {
  type: "eip6963:announceProvider";
  detail: EIP6963ProviderDetail;
}

interface EIP6963RequestProviderEvent extends Event {
  type: "eip6963:requestProvider";
}

export class EthereumProvider extends EventEmitter {
  chainId: string | null = null;
  selectedAddress: string | null = null;
  /**
   * The network ID of the currently connected Ethereum chain.
   * @deprecated
   */
  networkVersion: string | null = null;
  isUnhosted = true;
  isMetaMask = true;
  _isUnhosted = true;

  _isReady = false;
  _isConnected = false;
  _initialized = false;
  _isUnlocked = false;

  _cacheRequestsBeforeReady: any[] = [];
  _cacheEventListenersBeforeReady: [string | symbol, () => any][] = [];

  _state: StateProvider = {
    accounts: null,
    isConnected: false,
    isUnlocked: false,
    initialized: false,
    isPermanentlyDisconnected: false,
  };

  _metamask = {
    isUnlocked: () => {
      return new Promise((resolve) => {
        resolve(this._isUnlocked);
      });
    },
  };

  private _pushEventHandlers: PushEventHandlers;
  private _requestPromise = new ReadyPromise(2);
  private _dedupePromise = new DedupePromise([]);
  private _bcm = new BroadcastChannelMessage(channelName);

  constructor({ maxListeners = 100 } = {}) {
    super();
    this.setMaxListeners(maxListeners);
    this.initialize();
    this.shimLegacy();
    this._pushEventHandlers = new PushEventHandlers(this);
  }

  initialize = async () => {
    document.addEventListener(
      "visibilitychange",
      this._requestPromiseCheckVisibility
    );

    this._bcm.connect().on("message", this._handleBackgroundMessage);
    domReadyCall(() => {
      const origin = location.origin;
      const icon =
        ($('head > link[rel~="icon"]') as HTMLLinkElement)?.href ||
        ($('head > meta[itemprop="image"]') as HTMLMetaElement)?.content;

      const name =
        document.title ||
        ($('head > meta[name="title"]') as HTMLMetaElement)?.content ||
        origin;

      this._bcm.request({
        method: "tabCheckin",
        params: { icon, name, origin },
      });

      this._requestPromise.check(2);
    });

    try {
      const { chainId, accounts, networkVersion, isUnlocked }: any =
        await this.requestInternalMethods({
          method: "getProviderState",
        });
      if (isUnlocked) {
        this._isUnlocked = true;
        this._state.isUnlocked = true;
      }
      this.chainId = chainId;
      this.networkVersion = networkVersion;
      this.emit("connect", { chainId });
      this._pushEventHandlers.chainChanged({
        chain: chainId,
        networkVersion,
      });

      this._pushEventHandlers.accountsChanged(accounts);
    } catch {
      //
    } finally {
      this._initialized = true;
      this._state.initialized = true;
      this.emit("_initialized");
    }
  };

  private _requestPromiseCheckVisibility = () => {
    if (document.visibilityState === "visible") {
      this._requestPromise.check(1);
    } else {
      this._requestPromise.uncheck(1);
    }
  };

  private _handleBackgroundMessage = ({ event, data }) => {
    log("[push event]", event, data);
    if (this._pushEventHandlers[event]) {
      return this._pushEventHandlers[event](data);
    }

    this.emit(event, data);
  };

  isConnected = () => {
    return true;
  };

  // TODO: support multi request!
  request = async (data) => {
    if (!this._isReady) {
      const promise = new Promise((resolve, reject) => {
        this._cacheRequestsBeforeReady.push({
          data,
          resolve,
          reject,
        });
      });
      return promise;
    }
    return this._dedupePromise.call(data.method, () => this._request(data));
  };

  _request = async (data) => {
    if (!data) {
      throw ethErrors.rpc.invalidRequest();
    }

    this._requestPromiseCheckVisibility();

    return this._requestPromise.call(() => {
      if (data.method !== "eth_call") {
        log("[request]", JSON.stringify(data, null, 2));
      }

      return this._bcm
        .request(data)
        .then((res) => {
          if (data.method !== "eth_call") {
            log("[request: success]", data.method, res);
          }
          return res;
        })
        .catch((err) => {
          if (data.method !== "eth_call") {
            log("[request: error]", data.method, serializeError(err));
          }
          throw serializeError(err);
        });
    });
  };

  requestInternalMethods = (data) => {
    return this._dedupePromise.call(data.method, () => this._request(data));
  };

  // shim to matamask legacy api
  sendAsync = (payload, callback) => {
    if (Array.isArray(payload)) {
      return Promise.all(
        payload.map(
          (item) =>
            new Promise((resolve) => {
              this.sendAsync(item, (err, res) => {
                // ignore error
                resolve(res);
              });
            })
        )
      ).then((result) => callback(null, result));
    }
    const { method, params, ...rest } = payload;
    this.request({ method, params })
      .then((result) => callback(null, { ...rest, method, result }))
      .catch((error) => callback(error, { ...rest, method, error }));
  };

  send = (payload, callback?) => {
    if (typeof payload === "string" && (!callback || Array.isArray(callback))) {
      // send(method, params? = [])
      return this.request({
        method: payload,
        params: callback,
      }).then((result) => ({
        id: undefined,
        jsonrpc: "2.0",
        result,
      }));
    }

    if (typeof payload === "object" && typeof callback === "function") {
      return this.sendAsync(payload, callback);
    }

    let result;
    switch (payload.method) {
      case "eth_accounts":
        result = this.selectedAddress ? [this.selectedAddress] : [];
        break;

      case "eth_coinbase":
        result = this.selectedAddress || null;
        break;

      default:
        throw new Error("sync method doesnt support");
    }

    return {
      id: payload.id,
      jsonrpc: payload.jsonrpc,
      result,
    };
  };

  shimLegacy = () => {
    const legacyMethods = [
      ["enable", "eth_requestAccounts"],
      ["net_version", "net_version"],
    ];

    for (const [_method, method] of legacyMethods) {
      this[_method] = () => this.request({ method });
    }
  };

  on = (event: string | symbol, handler: (...args: any[]) => void) => {
    if (!this._isReady) {
      this._cacheEventListenersBeforeReady.push([event, handler]);
      return this;
    }
    return super.on(event, handler);
  };
}

declare global {
  interface Window {
    ethereum: EthereumProvider;
    web3: any;
    unhosted: EthereumProvider;
    unhostedWalletRouter: {
      unhostedProvider: EthereumProvider;
      lastInjectedProvider?: EthereumProvider;
      currentProvider: EthereumProvider;
      providers: EthereumProvider[];
      setDefaultProvider: (unhostedAsDefault: boolean) => void;
      addProvider: (provider: EthereumProvider) => void;
    };
  }
}

const provider = new EthereumProvider();
patchProvider(provider);
const unhostedProvider = new Proxy(provider, {
  deleteProperty: (target, prop) => {
    if (
      typeof prop === "string" &&
      ["on", "isUnhosted", "isMetaMask", "_isUnhosted"].includes(prop)
    ) {
      // @ts-ignore
      delete target[prop];
    }
    return true;
  },
});

const requestHasOtherProvider = () => {
  return provider.requestInternalMethods({
    method: "hasOtherProvider",
    params: [],
  });
};

const requestIsDefaultWallet = () => {
  return provider.requestInternalMethods({
    method: "isDefaultWallet",
    params: [],
  }) as Promise<boolean>;
};

const initOperaProvider = () => {
  window.ethereum = unhostedProvider;
  unhostedProvider._isReady = true;
  window.unhosted = unhostedProvider;
  patchProvider(unhostedProvider);
  unhostedProvider.on("unhosted:chainChanged", switchChainNotice);
};

const initProvider = () => {
  unhostedProvider._isReady = true;
  unhostedProvider.on("defaultWalletChanged", switchWalletNotice);
  patchProvider(unhostedProvider);
  if (window.ethereum) {
    requestHasOtherProvider();
  }
  if (!window.web3) {
    window.web3 = {
      currentProvider: unhostedProvider,
    };
  }
  const descriptor = Object.getOwnPropertyDescriptor(window, "ethereum");
  const canDefine = !descriptor || descriptor.configurable;
  if (canDefine) {
    try {
      Object.defineProperties(window, {
        unhosted: {
          value: unhostedProvider,
          configurable: false,
          writable: false,
        },
        ethereum: {
          get() {
            return window.unhostedWalletRouter.currentProvider;
          },
          set(newProvider) {
            window.unhostedWalletRouter.addProvider(newProvider);
          },
          configurable: false,
        },
        unhostedWalletRouter: {
          value: {
            unhostedProvider,
            lastInjectedProvider: window.ethereum,
            currentProvider: unhostedProvider,
            providers: [
              unhostedProvider,
              ...(window.ethereum ? [window.ethereum] : []),
            ],
            setDefaultProvider(unhostedAsDefault: boolean) {
              if (unhostedAsDefault) {
                window.unhostedWalletRouter.currentProvider = window.unhosted;
              } else {
                const nonDefaultProvider =
                  window.unhostedWalletRouter.lastInjectedProvider ??
                  window.ethereum;
                window.unhostedWalletRouter.currentProvider =
                  nonDefaultProvider;
              }
            },
            addProvider(provider) {
              if (!window.unhostedWalletRouter.providers.includes(provider)) {
                window.unhostedWalletRouter.providers.push(provider);
              }
              if (unhostedProvider !== provider) {
                requestHasOtherProvider();
                window.unhostedWalletRouter.lastInjectedProvider = provider;
              }
            },
          },
          configurable: false,
          writable: false,
        },
      });
    } catch (e) {
      // think that defineProperty failed means there is any other wallet
      requestHasOtherProvider();
      console.error(e);
      window.ethereum = unhostedProvider;
      window.unhosted = unhostedProvider;
    }
  } else {
    window.ethereum = unhostedProvider;
    window.unhosted = unhostedProvider;
  }
};

if (isOpera) {
  initOperaProvider();
} else {
  initProvider();
}

requestIsDefaultWallet().then((unhostedAsDefault) => {
  window.unhostedWalletRouter?.setDefaultProvider(unhostedAsDefault);
  if (unhostedAsDefault) {
    window.ethereum = unhostedProvider;
    unhostedProvider.on("unhosted:chainChanged", switchChainNotice);
  }
});

const announceEip6963Provider = (provider: EthereumProvider) => {
  const info: EIP6963ProviderInfo = {
    uuid: uuid,
    name: "Unhosted Wallet",
    icon: iconb64,
    rdns: "io.unhosted",
  };

  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info, provider }),
    })
  );
};

window.addEventListener<any>(
  "eip6963:requestProvider",
  (event: EIP6963RequestProviderEvent) => {
    announceEip6963Provider(unhostedProvider);
  }
);

announceEip6963Provider(unhostedProvider);

window.dispatchEvent(new Event("ethereum#initialized"));
