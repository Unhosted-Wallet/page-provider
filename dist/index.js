'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var events = require('events');
var ethRpcErrors = require('eth-rpc-errors');

/**
 * this script is live in content-script / dapp's page
 */
class Message extends events.EventEmitter {
    constructor() {
        super(...arguments);
        // avaiable id list
        // max concurrent request limit
        this._requestIdPool = [...Array(1000).keys()];
        this._EVENT_PRE = 'ETH_WALLET_';
        this._waitingMap = new Map();
        this.request = (data) => {
            if (!this._requestIdPool.length) {
                throw ethRpcErrors.ethErrors.rpc.limitExceeded();
            }
            const ident = this._requestIdPool.shift();
            return new Promise((resolve, reject) => {
                this._waitingMap.set(ident, {
                    data,
                    resolve,
                    reject,
                });
                this.send('request', { ident, data });
            });
        };
        this.onResponse = async ({ ident, res, err } = {}) => {
            // the url may update
            if (!this._waitingMap.has(ident)) {
                return;
            }
            const { resolve, reject } = this._waitingMap.get(ident);
            this._requestIdPool.push(ident);
            this._waitingMap.delete(ident);
            err ? reject(err) : resolve(res);
        };
        this.onRequest = async ({ ident, data }) => {
            if (this.listenCallback) {
                let res, err;
                try {
                    res = await this.listenCallback(data);
                }
                catch (e) {
                    err = {
                        message: e.message,
                        stack: e.stack,
                    };
                    e.code && (err.code = e.code);
                    e.data && (err.data = e.data);
                }
                this.send('response', { ident, res, err });
            }
        };
        this._dispose = () => {
            for (const request of this._waitingMap.values()) {
                request.reject(ethRpcErrors.ethErrors.provider.userRejectedRequest());
            }
            this._waitingMap.clear();
        };
    }
}

class BroadcastChannelMessage extends Message {
    constructor(name) {
        super();
        this.connect = () => {
            this._channel.onmessage = ({ data: { type, data } }) => {
                if (type === 'message') {
                    this.emit('message', data);
                }
                else if (type === 'response') {
                    this.onResponse(data);
                }
            };
            return this;
        };
        this.listen = (listenCallback) => {
            this.listenCallback = listenCallback;
            this._channel.onmessage = ({ data: { type, data } }) => {
                if (type === 'request') {
                    this.onRequest(data);
                }
            };
            return this;
        };
        this.send = (type, data) => {
            this._channel.postMessage({
                type,
                data,
            });
        };
        this.dispose = () => {
            this._dispose();
            this._channel.close();
        };
        if (!name) {
            throw new Error('the broadcastChannel name is missing');
        }
        this._channel = new BroadcastChannel(name);
    }
}

class PushEventHandlers {
    constructor(provider) {
        this.connect = (data) => {
            if (!this.provider._isConnected) {
                this.provider._isConnected = true;
                this.provider._state.isConnected = true;
                this._emit("connect", data);
            }
        };
        this.unlock = () => {
            this.provider._isUnlocked = true;
            this.provider._state.isUnlocked = true;
        };
        this.lock = () => {
            this.provider._isUnlocked = false;
        };
        this.disconnect = () => {
            this.provider._isConnected = false;
            this.provider._state.isConnected = false;
            this.provider._state.accounts = null;
            this.provider.selectedAddress = null;
            const disconnectError = ethRpcErrors.ethErrors.provider.disconnected();
            this._emit("accountsChanged", []);
            this._emit("disconnect", disconnectError);
            this._emit("close", disconnectError);
        };
        this.accountsChanged = (accounts) => {
            if ((accounts === null || accounts === void 0 ? void 0 : accounts[0]) === this.provider.selectedAddress) {
                return;
            }
            this.provider.selectedAddress = accounts === null || accounts === void 0 ? void 0 : accounts[0];
            this.provider._state.accounts = accounts;
            this._emit("accountsChanged", accounts);
        };
        this.chainChanged = ({ chain, networkVersion }) => {
            this.connect({ chainId: chain });
            if (chain !== this.provider.chainId) {
                this.provider.chainId = chain;
                this._emit("chainChanged", chain);
            }
            if (networkVersion !== this.provider.networkVersion) {
                this.provider.networkVersion = networkVersion;
                this._emit("networkChanged", networkVersion);
            }
        };
        this["unhosted:chainChanged"] = (chain) => {
            var _a, _b;
            if (chain &&
                ((_a = chain.hex) === null || _a === void 0 ? void 0 : _a.toLowerCase()) !== ((_b = this.provider.chainId) === null || _b === void 0 ? void 0 : _b.toLowerCase())) {
                this._emit("unhosted:chainChanged", chain);
            }
        };
        this.provider = provider;
    }
    _emit(event, data) {
        if (this.provider._initialized && this.provider._isReady) {
            this.provider.emit(event, data);
        }
    }
}

const domReadyCall = (callback) => {
    if (document.readyState === "loading") {
        const domContentLoadedHandler = () => {
            callback();
            document.removeEventListener("DOMContentLoaded", domContentLoadedHandler);
        };
        document.addEventListener("DOMContentLoaded", domContentLoadedHandler);
    }
    else {
        callback();
    }
};
const $ = document.querySelector.bind(document);

class ReadyPromise {
    constructor(count) {
        this._allCheck = [];
        this._tasks = [];
        this.check = (index) => {
            this._allCheck[index - 1] = true;
            this._proceed();
        };
        this.uncheck = (index) => {
            this._allCheck[index - 1] = false;
        };
        this._proceed = () => {
            if (this._allCheck.some((_) => !_)) {
                return;
            }
            while (this._tasks.length) {
                const { resolve, fn } = this._tasks.shift();
                resolve(fn());
            }
        };
        this.call = (fn) => {
            return new Promise((resolve) => {
                this._tasks.push({
                    fn,
                    resolve,
                });
                this._proceed();
            });
        };
        this._allCheck = [...Array(count)];
    }
}

class DedupePromise {
    constructor(blackList) {
        this._tasks = {};
        this._blackList = blackList;
    }
    async call(key, defer) {
        if (this._blackList.includes(key) && this._tasks[key]) {
            throw ethRpcErrors.ethErrors.rpc.transactionRejected('there is a pending request, please request after it resolved');
        }
        return new Promise((resolve) => {
            this._tasks[key] = (this._tasks[key] || 0) + 1;
            resolve(defer().finally(() => {
                this._tasks[key]--;
                if (!this._tasks[key]) {
                    delete this._tasks[key];
                }
            }));
        });
    }
}

var img$4 = "data:image/svg+xml,%3csvg width='20' height='20' viewBox='0 0 20 20' fill='none' xmlns='http://www.w3.org/2000/svg'%3e%3cpath d='M19.3838 11.1837C20.1286 9.52002 16.4468 4.87188 12.9295 2.93537C10.7124 1.43518 8.40221 1.64128 7.93432 2.29998C6.9075 3.74555 11.3344 4.97045 14.2951 6.39983C13.6586 6.67624 13.0589 7.17228 12.7062 7.80665C11.6025 6.60164 9.17989 5.56396 6.33724 6.39983C4.42164 6.96311 2.82963 8.29105 2.21432 10.2967C2.06481 10.2303 1.89928 10.1934 1.72513 10.1934C1.05916 10.1934 0.519287 10.7333 0.519287 11.3992C0.519287 12.0652 1.05916 12.6051 1.72513 12.6051C1.84857 12.6051 2.23453 12.5223 2.23453 12.5223L8.40221 12.567C5.93562 16.4799 3.98632 17.052 3.98632 17.7299C3.98632 18.4078 5.85145 18.2241 6.55177 17.9714C9.90427 16.7617 13.505 12.9918 14.1229 11.9065C16.7176 12.2302 18.8983 12.2685 19.3838 11.1837Z' fill='url(%23paint0_linear_17938_5195)'/%3e%3cpath fill-rule='evenodd' clip-rule='evenodd' d='M14.2947 6.40006C14.2949 6.40013 14.295 6.40021 14.2952 6.40028C14.4324 6.34622 14.4102 6.14354 14.3725 5.98438C14.2859 5.61855 12.7916 4.14293 11.3883 3.48199C9.47625 2.58142 8.06824 2.6278 7.86011 3.04284C8.24958 3.84115 10.0553 4.59066 11.9412 5.37346C12.7458 5.70743 13.565 6.04745 14.2951 6.39991C14.2949 6.39996 14.2948 6.40001 14.2947 6.40006Z' fill='url(%23paint1_linear_17938_5195)'/%3e%3cpath fill-rule='evenodd' clip-rule='evenodd' d='M11.8686 14.4346C11.4819 14.2868 11.0451 14.1512 10.5484 14.0282C11.0779 13.0807 11.1891 11.678 10.689 10.7911C9.98712 9.54649 9.1061 8.88403 7.05884 8.88403C5.93283 8.88403 2.90114 9.26331 2.84732 11.7941C2.84167 12.0596 2.84718 12.303 2.8664 12.5268L8.4025 12.5669C7.65616 13.7509 6.95718 14.629 6.34523 15.2968C7.07996 15.485 7.68629 15.6431 8.24294 15.7882C8.77114 15.9259 9.25462 16.0519 9.76063 16.181C10.524 15.6249 11.2416 15.0185 11.8686 14.4346Z' fill='url(%23paint2_linear_17938_5195)'/%3e%3cpath d='M2.14044 12.2667C2.36659 14.1893 3.4592 14.9427 5.69184 15.1657C7.92448 15.3886 9.20516 15.2391 10.9102 15.3942C12.3342 15.5237 13.6057 16.2494 14.0773 15.9986C14.5019 15.7729 14.2644 14.9576 13.6963 14.4345C12.96 13.7564 11.941 13.2849 10.1479 13.1176C10.5052 12.1392 10.4051 10.7673 9.85009 10.021C9.04764 8.94179 7.56647 8.45388 5.69184 8.66705C3.73329 8.88977 1.85661 9.85402 2.14044 12.2667Z' fill='url(%23paint3_linear_17938_5195)'/%3e%3cdefs%3e%3clinearGradient id='paint0_linear_17938_5195' x1='6.11419' y1='9.71043' x2='19.2235' y2='13.428' gradientUnits='userSpaceOnUse'%3e%3cstop stop-color='%238797FF'/%3e%3cstop offset='1' stop-color='%23AAA8FF'/%3e%3c/linearGradient%3e%3clinearGradient id='paint1_linear_17938_5195' x1='17.0159' y1='9.46126' x2='7.55701' y2='-0.0207884' gradientUnits='userSpaceOnUse'%3e%3cstop stop-color='%233B22A0'/%3e%3cstop offset='1' stop-color='%235156D8' stop-opacity='0'/%3e%3c/linearGradient%3e%3clinearGradient id='paint2_linear_17938_5195' x1='12.1318' y1='14.7649' x2='3.0454' y2='9.54082' gradientUnits='userSpaceOnUse'%3e%3cstop stop-color='%233B1E8F'/%3e%3cstop offset='1' stop-color='%236A6FFB' stop-opacity='0'/%3e%3c/linearGradient%3e%3clinearGradient id='paint3_linear_17938_5195' x1='6.89681' y1='9.61258' x2='13.0385' y2='17.4162' gradientUnits='userSpaceOnUse'%3e%3cstop stop-color='%238898FF'/%3e%3cstop offset='0.983895' stop-color='%235F47F1'/%3e%3c/linearGradient%3e%3c/defs%3e%3c/svg%3e";

var img$3 = "data:image/svg+xml,%3csvg width='14' height='14' viewBox='0 0 14 14' fill='none' xmlns='http://www.w3.org/2000/svg'%3e%3cg clip-path='url(%23clip0_77148_74145)'%3e%3cpath d='M7 13C10.3137 13 13 10.3137 13 7C13 3.68629 10.3137 1 7 1C3.68629 1 1 3.68629 1 7C1 10.3137 3.68629 13 7 13Z' stroke='%23FFB020' stroke-miterlimit='10'/%3e%3cpath d='M7 7.4375V4.375' stroke='%23FFB020' stroke-width='0.875' stroke-linecap='round' stroke-linejoin='round'/%3e%3cpath d='M7 10.0625C7.36244 10.0625 7.65625 9.76869 7.65625 9.40625C7.65625 9.04381 7.36244 8.75 7 8.75C6.63756 8.75 6.34375 9.04381 6.34375 9.40625C6.34375 9.76869 6.63756 10.0625 7 10.0625Z' fill='%23FFB020'/%3e%3c/g%3e%3cdefs%3e%3cclipPath id='clip0_77148_74145'%3e%3crect width='14' height='14' fill='white'/%3e%3c/clipPath%3e%3c/defs%3e%3c/svg%3e";

var img$2 = "data:image/svg+xml,%3csvg width='14' height='14' viewBox='0 0 14 14' fill='none' xmlns='http://www.w3.org/2000/svg'%3e%3cpath d='M8.83594 3.49681L12.4196 7.08044L8.83594 10.6641' stroke='%23192945' stroke-linecap='round' stroke-linejoin='round'/%3e%3cpath d='M2.07031 7.08594L12.423 7.08594' stroke='%23192945' stroke-linecap='round' stroke-linejoin='round'/%3e%3c/svg%3e";

var img$1 = "data:image/svg+xml,%3csvg width='16' height='16' viewBox='0 0 16 16' fill='none' xmlns='http://www.w3.org/2000/svg'%3e%3cpath d='M16 0H0V16H16V0Z' fill='white' fill-opacity='0.01'/%3e%3cpath d='M2.66663 2.66663L13.3333 13.3333' stroke='%23707280' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3e%3cpath d='M2.66663 13.3333L13.3333 2.66663' stroke='%23707280' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3e%3c/svg%3e";

class Notice {
    constructor(options) {
        this.options = options;
        this.el = document.createElement("div");
        this.el.className = `unhosted-notice ${this.options.className ? this.options.className : ""}`;
        // initial events
        this.events = {};
        // inner element
        this.insert();
        // auto hide animation
        if (this.options.timeout) {
            this.startTimer();
        }
        // mouse events
        this.registerEvents();
    }
    insert() {
        var _a;
        if (!this.el) {
            return;
        }
        // main
        const elMain = document.createElement("div");
        elMain.className = "unhosted-notice-content";
        elMain.innerHTML = this.options.content;
        (_a = this.el) === null || _a === void 0 ? void 0 : _a.appendChild(elMain);
        // close button
        if (this.options.closeable) {
            this.closeButton = document.createElement("img");
            this.closeButton.setAttribute("src", img$1);
            this.closeButton.className = "unhosted-notice-close";
            this.el.appendChild(this.closeButton);
        }
        this.options.container.appendChild(this.el);
    }
    registerEvents() {
        var _a;
        this.events.hide = () => this.hide();
        (_a = this.closeButton) === null || _a === void 0 ? void 0 : _a.addEventListener("click", this.events.hide, false);
    }
    startTimer(timeout = this.options.timeout) {
        this.timer = setTimeout(() => {
            this.hide();
        }, timeout);
    }
    stopTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
    hide() {
        if (!this.el) {
            return;
        }
        this.el.classList.add(".unhosted-notice-is-hide");
        // setTimeout(() => {
        this.options.container.removeChild(this.el);
        this.el = null;
        if (this.options.onHide) {
            this.options.onHide();
        }
        this.stopTimer();
        // }, 300);
    }
}
let container = null;
let style = null;
const styles = `
    .unhosted-notice-container {
      position: fixed;
      z-index: 99999;
      top: 60px;
      right: 42px;
    }
    .unhosted-notice {
      min-width: 230px;
      min-height: 44px;
      background: #FFFFFF;
      border: 1px solid #8697FF;
      border: 1.5px solid #8697FF;
      box-sizing: border-box;
      box-shadow: 0px 24px 40px rgba(134, 151, 255, 0.12);
      border-radius: 6px;
      display: flex;
      align-items: center;

      font-family: 'Arial', sans-serif;
      font-style: normal;
      font-weight: 400;
      font-size: 14px;
      line-height: 16px;
      color: #13141A;

      padding: 12px;
      gap: 8px;

      opacity: 1;
    }
    .unhosted-notice + .unhosted-notice {
      margin-top: 30px;
    }
    .unhosted-notice-content {
      display: flex;
      align-items: center;
      color: #13141A;
    }
    .unhosted-notice-is-hide {
      opacity: 0;
      transition: 0.3s;
    }

    .unhosted-notice-icon {
      width: 20px;
    }
    .unhosted-notice-close {
      flex-shrink: 0;
      margin-left: 16px;
      width: 16px;
      height: 16px;
      cursor: pointer;
    }
    .unhosted-strong {
      font-weight: bold;
      color: #13141A;
    }
    .unhosted-notice-default-wallet {
      border-radius: 12px;
      height: 64px;
      padding-left: 16px;
      padding-right: 20px;

      font-size: 12px;
      line-height: 16px;

      color: #13141A;
    }
  `;
function notice(options) {
    const { content = "", 
    // timeout = 3000,
    timeout = 0, closeButton = "×", className = "", closeable = false, } = options || {};
    if (!container) {
        container = document.createElement("div");
        container.classList.add("unhosted-notice-container");
        style = document.createElement("style");
        style.innerHTML = styles;
        document.body.appendChild(style);
        document.body.appendChild(container);
    }
    return new Notice({
        content,
        timeout,
        closeButton,
        container,
        className,
        closeable,
        onHide: () => {
            if (container && !(container === null || container === void 0 ? void 0 : container.hasChildNodes())) {
                document.body.removeChild(container);
                style && document.body.removeChild(style);
                style = null;
                container = null;
            }
        },
    });
}

const isInIframe = () => {
    return window.self !== window.top;
};
const isInSameOriginIframe = () => {
    var _a, _b;
    if (!isInIframe()) {
        return false;
    }
    try {
        return window.self.location.origin === ((_b = (_a = window.top) === null || _a === void 0 ? void 0 : _a.location) === null || _b === void 0 ? void 0 : _b.origin);
    }
    catch (e) {
        return false;
    }
};

let instance$1;
const switchChainNotice = (chain) => {
    var _a, _b;
    if (isInSameOriginIframe()) {
        return;
    }
    if (instance$1) {
        instance$1.hide();
        instance$1 = null;
    }
    const isSwitchToMainnet = (chain === null || chain === void 0 ? void 0 : chain.prev) && ((_a = chain === null || chain === void 0 ? void 0 : chain.prev) === null || _a === void 0 ? void 0 : _a.isTestnet) && !(chain === null || chain === void 0 ? void 0 : chain.isTestnet);
    const isSwitchToTestnet = (chain === null || chain === void 0 ? void 0 : chain.prev) && !((_b = chain === null || chain === void 0 ? void 0 : chain.prev) === null || _b === void 0 ? void 0 : _b.isTestnet) && (chain === null || chain === void 0 ? void 0 : chain.isTestnet);
    const rawContent = `<img style="width: 20px; margin-right: 8px;" src="${img$4}"/>Switched to <span class="unhosted-strong" style="margin: 0 8px;">${chain === null || chain === void 0 ? void 0 : chain.name}</span> for the current Dapp`;
    let content = rawContent;
    if (isSwitchToMainnet || isSwitchToTestnet) {
        content = `
    <div>
      <div style="display: flex; align-items: center; justify-content: center; color: #13141A;">
        ${rawContent}
      </div>
      <div style="display: flex;align-items:center;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid #d3d8e0;border-top-width:0.5px; color: #13141A;">
        <img style="width: 14px;" src="${img$3}"/>
        ${isSwitchToMainnet
            ? `Testnet <img style="width: 14px;" src="${img$2}"/> Mainnet`
            : ""}
        ${isSwitchToTestnet
            ? `Mainnet <img style="width: 14px;" src="${img$2}"/> Testnet`
            : ""}
      </div>
    </div>
    `;
    }
    instance$1 = notice({
        timeout: 3000,
        content,
    });
};

var img = "data:image/svg+xml,%3csvg width='40' height='40' viewBox='0 0 40 40' fill='none' xmlns='http://www.w3.org/2000/svg'%3e%3cpath d='M34.5002 5.11523L21.9277 14.4177L24.2652 8.93523L34.5015 5.11523H34.5002Z' fill='%23E17726'/%3e%3cpath d='M34.6389 5.03915C34.6569 5.07236 34.6625 5.11097 34.6544 5.14792C34.6464 5.18487 34.6253 5.2177 34.5951 5.2404L22.0214 14.5442C21.9935 14.5643 21.9598 14.5748 21.9255 14.574C21.8911 14.5733 21.8579 14.5613 21.831 14.5399C21.8041 14.5185 21.7849 14.4889 21.7764 14.4556C21.7679 14.4223 21.7705 14.3871 21.7839 14.3554L24.1214 8.87291C24.1297 8.85316 24.142 8.83533 24.1575 8.8205C24.1729 8.80567 24.1913 8.79415 24.2114 8.78666L34.4464 4.96665C34.4818 4.95366 34.5207 4.95383 34.5561 4.96714C34.5914 4.98045 34.6208 5.006 34.6389 5.03915V5.03915ZM24.3839 9.05791L22.3001 13.9454L33.5076 5.6529L24.3839 9.05791Z' fill='%23E17726'/%3e%3cpath d='M5.5 5.11523L17.96 14.5052L15.735 8.93523L5.5 5.11523Z' fill='%23E27625'/%3e%3cpath d='M5.36134 5.0385C5.37965 5.00529 5.40932 4.9798 5.44492 4.96671C5.48051 4.95362 5.51963 4.95381 5.55509 4.96725L15.7901 8.78725C15.8313 8.8035 15.8651 8.836 15.8801 8.876L18.1063 14.446C18.1186 14.4778 18.1202 14.5126 18.111 14.5454C18.1018 14.5782 18.0822 14.607 18.0551 14.6277C18.0281 14.6484 17.9951 14.6598 17.9611 14.6602C17.927 14.6605 17.8938 14.6499 17.8663 14.6298L5.40384 5.23975C5.37412 5.21692 5.35352 5.18424 5.34573 5.14759C5.33794 5.11093 5.34347 5.0727 5.36134 5.03975V5.0385ZM6.46134 5.641L17.6051 14.0398L15.6138 9.0585L6.46009 5.641H6.46134Z' fill='%23E27625'/%3e%3cpath d='M29.9739 26.6868L26.6289 31.7968L33.7914 33.7693L35.8439 26.798L29.9739 26.6855V26.6868Z' fill='%23E27625'/%3e%3cpath d='M29.8414 26.6006C29.856 26.5782 29.8761 26.56 29.8997 26.5475C29.9233 26.535 29.9497 26.5288 29.9764 26.5293L35.8464 26.6418C35.8704 26.6423 35.8941 26.6482 35.9155 26.6592C35.9369 26.6702 35.9555 26.686 35.9699 26.7053C35.9842 26.7246 35.994 26.747 35.9983 26.7706C36.0027 26.7943 36.0016 26.8187 35.9951 26.8418L33.9426 33.8143C33.931 33.8539 33.9043 33.8873 33.8683 33.9074C33.8323 33.9275 33.7899 33.9327 33.7501 33.9218L26.5876 31.9493C26.5637 31.9429 26.5416 31.9308 26.5232 31.9142C26.5048 31.8976 26.4906 31.8769 26.4817 31.8538C26.4728 31.8306 26.4695 31.8057 26.472 31.781C26.4746 31.7564 26.4829 31.7327 26.4964 31.7118L29.8426 26.5993L29.8414 26.6006ZM30.0576 26.8456L26.8789 31.7031L33.6839 33.5768L35.6339 26.9518L30.0589 26.8456H30.0576Z' fill='%23E27625'/%3e%3cpath d='M4.16895 26.7968L6.2077 33.768L13.3589 31.7955L10.0264 26.6855L4.16895 26.7968V26.7968Z' fill='%23E27625'/%3e%3cpath d='M10.0226 26.5293C10.0776 26.5281 10.1288 26.5543 10.1576 26.6006L13.4913 31.7106C13.5048 31.7313 13.5132 31.755 13.5158 31.7796C13.5184 31.8041 13.5153 31.829 13.5065 31.8521C13.4977 31.8753 13.4836 31.896 13.4654 31.9127C13.4471 31.9293 13.4252 31.9415 13.4013 31.9481L6.25008 33.9218C6.21031 33.9327 6.16787 33.9275 6.13188 33.9074C6.09589 33.8873 6.06921 33.8539 6.05758 33.8143L4.01758 26.8431C4.0111 26.82 4.00998 26.7958 4.01429 26.7722C4.0186 26.7486 4.02824 26.7263 4.04246 26.7071C4.05669 26.6878 4.07513 26.672 4.09637 26.6609C4.11762 26.6498 4.14112 26.6437 4.16508 26.6431L10.0226 26.5306V26.5293ZM4.37758 26.9518L6.31508 33.5768L13.1088 31.7018L9.94133 26.8456L4.37883 26.9518H4.37758Z' fill='%23E27625'/%3e%3cpath d='M12.9739 18.0525L10.9839 21.0537L18.0714 21.3762L17.8376 13.75L12.9751 18.0537L12.9739 18.0525Z' fill='%23E27625'/%3e%3cpath d='M17.8987 13.6031C17.955 13.6281 17.9912 13.6818 17.9937 13.7431L18.23 21.3718C18.2307 21.3936 18.2269 21.4152 18.2188 21.4354C18.2107 21.4556 18.1986 21.474 18.1831 21.4892C18.1676 21.5045 18.1491 21.5164 18.1287 21.5241C18.1084 21.5319 18.0867 21.5354 18.065 21.5343L10.9775 21.2106C10.9497 21.2094 10.9226 21.2009 10.8992 21.1858C10.8758 21.1708 10.8567 21.1499 10.844 21.1251C10.8313 21.1003 10.8254 21.0726 10.8269 21.0448C10.8284 21.017 10.8372 20.9901 10.8525 20.9668L12.8425 17.9643C12.8499 17.9533 12.8587 17.9432 12.8687 17.9343L17.7312 13.6293C17.7537 13.6094 17.7815 13.5964 17.8111 13.5917C17.8408 13.5871 17.8712 13.591 17.8987 13.6031V13.6031ZM13.0937 18.1556L11.2687 20.9093L17.91 21.2106L17.6887 14.0881L13.0937 18.1556V18.1556Z' fill='%23E27625'/%3e%3cpath d='M27.0265 18.0534L22.089 13.6621L21.9277 21.3784L29.0152 21.0559L27.0265 18.0534V18.0534Z' fill='%23E27625'/%3e%3cpath d='M22.025 13.5175C22.0527 13.5052 22.0834 13.5011 22.1133 13.5058C22.1432 13.5104 22.1712 13.5236 22.1938 13.5438L27.1313 17.935C27.1413 17.9439 27.1501 17.954 27.1575 17.965L29.1475 20.9675C29.1628 20.9908 29.1716 21.0177 29.1731 21.0455C29.1746 21.0733 29.1687 21.101 29.156 21.1258C29.1433 21.1506 29.1242 21.1715 29.1008 21.1865C29.0774 21.2016 29.0504 21.2101 29.0225 21.2113L21.935 21.5338C21.9135 21.5348 21.892 21.5314 21.8719 21.5238C21.8517 21.5162 21.8333 21.5045 21.8179 21.4895C21.8024 21.4745 21.7902 21.4565 21.782 21.4366C21.7737 21.4167 21.7697 21.3953 21.77 21.3738L21.9325 13.6588C21.9331 13.6287 21.9422 13.5995 21.9588 13.5744C21.9754 13.5494 21.9988 13.5297 22.0263 13.5175H22.025ZM22.2388 14.005L22.0888 21.2125L28.7313 20.91L26.9063 18.1563L22.24 14.0063L22.2388 14.005Z' fill='%23E27625'/%3e%3cpath d='M13.3589 31.7957L17.6501 29.7245L13.9564 26.8457L13.3589 31.7957Z' fill='%23E27625'/%3e%3cpath d='M13.8952 26.7016C13.921 26.6908 13.9492 26.6871 13.9768 26.6909C14.0045 26.6946 14.0307 26.7056 14.0527 26.7228L17.7465 29.6003C17.7677 29.6167 17.7843 29.6382 17.7949 29.6629C17.8054 29.6875 17.8095 29.7144 17.8068 29.7411C17.804 29.7678 17.7945 29.7933 17.7792 29.8152C17.7638 29.8372 17.7431 29.8549 17.719 29.8666L13.4277 31.9378C13.4023 31.9501 13.3741 31.9553 13.346 31.953C13.3178 31.9506 13.2909 31.9407 13.2679 31.9244C13.2449 31.908 13.2267 31.8858 13.2152 31.86C13.2038 31.8342 13.1995 31.8058 13.2027 31.7778L13.8002 26.8278C13.8037 26.8005 13.8144 26.7746 13.831 26.7526C13.8477 26.7307 13.8698 26.7135 13.8952 26.7028V26.7016ZM14.079 27.1428L13.5502 31.5303L17.3527 29.6928L14.079 27.1428V27.1428Z' fill='%23E27625'/%3e%3cpath d='M22.3501 29.7245L26.6288 31.7957L26.0438 26.8457L22.3501 29.7245V29.7245Z' fill='%23E27625'/%3e%3cpath d='M26.1048 26.7016C26.1305 26.7125 26.1529 26.73 26.1696 26.7524C26.1863 26.7749 26.1967 26.8013 26.1998 26.8291L26.7848 31.7791C26.7878 31.807 26.7833 31.8352 26.7717 31.8608C26.7602 31.8864 26.742 31.9084 26.719 31.9246C26.6961 31.9408 26.6692 31.9506 26.6412 31.9529C26.6132 31.9552 26.5851 31.95 26.5598 31.9378L22.2823 29.8666C22.2581 29.855 22.2373 29.8374 22.2218 29.8155C22.2063 29.7936 22.1967 29.7681 22.1938 29.7414C22.1909 29.7148 22.1949 29.6878 22.2053 29.6631C22.2158 29.6384 22.2324 29.6168 22.2535 29.6003L25.9473 26.7228C25.9693 26.7056 25.9955 26.6946 26.0232 26.6909C26.0509 26.6871 26.079 26.6908 26.1048 26.7016ZM22.6473 29.6941L26.4386 31.5291L25.9198 27.1428L22.6473 29.6928V29.6941Z' fill='%23E27625'/%3e%3cpath d='M26.6288 31.7959L22.3501 29.7246L22.6988 32.5034L22.6613 33.6821L26.6288 31.7959V31.7959Z' fill='%23D5BFB2'/%3e%3cpath d='M22.2586 29.5977C22.2815 29.5813 22.3085 29.5714 22.3367 29.5689C22.3648 29.5665 22.3931 29.5717 22.4186 29.584L26.6973 31.6552C26.724 31.6682 26.7464 31.6885 26.762 31.7136C26.7777 31.7388 26.7859 31.7679 26.7858 31.7975C26.7857 31.8271 26.7772 31.8561 26.7613 31.8812C26.7454 31.9062 26.7228 31.9262 26.6961 31.939L22.7286 33.824C22.7042 33.8355 22.6774 33.8406 22.6505 33.8389C22.6237 33.8371 22.5977 33.8284 22.5752 33.8138C22.5526 33.7991 22.5342 33.7789 22.5216 33.7551C22.5091 33.7313 22.5029 33.7046 22.5036 33.6777L22.5411 32.5115L22.1936 29.7452C22.1901 29.7171 22.1943 29.6885 22.2058 29.6625C22.2172 29.6366 22.2354 29.6142 22.2586 29.5977V29.5977ZM22.5423 29.994L22.8548 32.484C22.8554 32.4923 22.8554 32.5007 22.8548 32.509L22.8273 33.429L26.2648 31.7952L22.5423 29.994V29.994Z' fill='%23D5BFB2'/%3e%3cpath d='M13.3589 31.7959L17.3389 33.6821L17.3139 32.5034L17.6501 29.7246L13.3589 31.7959Z' fill='%23D5BFB2'/%3e%3cpath d='M17.7413 29.5982C17.7642 29.6146 17.7823 29.6368 17.7937 29.6625C17.8051 29.6882 17.8095 29.7165 17.8063 29.7445L17.4713 32.512L17.4963 33.6795C17.4967 33.7063 17.4903 33.7328 17.4777 33.7564C17.4651 33.78 17.4466 33.8001 17.4241 33.8146C17.4016 33.8291 17.3757 33.8376 17.349 33.8394C17.3222 33.8411 17.2955 33.836 17.2713 33.8245L13.2913 31.9395C13.2646 31.9266 13.242 31.9065 13.2263 31.8814C13.2105 31.8563 13.2021 31.8273 13.2021 31.7976C13.2021 31.768 13.2105 31.7389 13.2263 31.7139C13.242 31.6888 13.2646 31.6686 13.2913 31.6557L17.5813 29.5845C17.6066 29.572 17.6348 29.5666 17.663 29.5688C17.6911 29.571 17.7182 29.5808 17.7413 29.597V29.5982ZM13.7238 31.7957L17.1763 33.4307L17.1563 32.5082L17.1575 32.4857L17.4575 29.9932L13.7238 31.7957Z' fill='%23D5BFB2'/%3e%3cpath d='M17.4127 25.0127L13.8564 23.9702L16.3689 22.8164L17.4127 25.0114V25.0127Z' fill='%23233447'/%3e%3cpath d='M16.3024 22.673C16.34 22.6554 16.3831 22.6534 16.4222 22.6675C16.4613 22.6815 16.4933 22.7105 16.5111 22.748L17.5549 24.9442C17.5679 24.9716 17.5727 25.0022 17.5687 25.0323C17.5648 25.0624 17.5522 25.0907 17.5325 25.1138C17.5128 25.1369 17.4869 25.1539 17.4578 25.1626C17.4288 25.1713 17.3978 25.1714 17.3686 25.163L13.8124 24.1205C13.7817 24.1115 13.7545 24.0933 13.7343 24.0685C13.7142 24.0436 13.7021 24.0132 13.6997 23.9814C13.6972 23.9495 13.7046 23.9176 13.7207 23.89C13.7368 23.8623 13.7609 23.8403 13.7899 23.8267L16.3024 22.673V22.673ZM14.3049 23.9367L17.1199 24.7617L16.2924 23.0242L14.3049 23.9367V23.9367Z' fill='%23233447'/%3e%3cpath d='M22.5877 25.0127L23.6314 22.8164L26.1564 23.9702L22.5864 25.0114L22.5877 25.0127Z' fill='%23233447'/%3e%3cpath d='M23.4886 22.7475C23.5065 22.7103 23.5382 22.6816 23.5771 22.6676C23.6159 22.6536 23.6586 22.6553 23.6961 22.6725L26.2211 23.8262C26.2501 23.8397 26.2743 23.8617 26.2905 23.8892C26.3067 23.9168 26.3142 23.9486 26.3119 23.9804C26.3096 24.0123 26.2976 24.0427 26.2776 24.0677C26.2576 24.0926 26.2305 24.1108 26.1999 24.12L22.6311 25.1625C22.6019 25.1713 22.5708 25.1714 22.5415 25.1628C22.5122 25.1543 22.486 25.1374 22.4661 25.1142C22.4463 25.091 22.4336 25.0626 22.4296 25.0323C22.4256 25.002 22.4305 24.9713 22.4436 24.9437L23.4886 22.7475V22.7475ZM23.7074 23.0225L22.8799 24.7612L25.7049 23.9362L23.7074 23.0237V23.0225Z' fill='%23233447'/%3e%3cpath d='M13.3589 31.7955L13.9814 26.6855L10.0264 26.7968L13.3589 31.7968V31.7955Z' fill='%23CC6228'/%3e%3cpath d='M14.0977 26.5799C14.113 26.5966 14.1245 26.6164 14.1314 26.638C14.1383 26.6596 14.1405 26.6824 14.1377 26.7049L13.5152 31.8149C13.5114 31.8469 13.4979 31.8769 13.4765 31.901C13.4551 31.9251 13.4268 31.942 13.3955 31.9495C13.3641 31.957 13.3312 31.9547 13.3012 31.9429C13.2713 31.9311 13.2456 31.9104 13.2277 31.8836L9.89524 26.8849C9.8796 26.8615 9.87051 26.8343 9.86891 26.8063C9.86731 26.7782 9.87326 26.7502 9.88615 26.7252C9.89903 26.7002 9.91838 26.6791 9.94218 26.6641C9.96599 26.6491 9.99337 26.6407 10.0215 26.6399L13.9765 26.5274C13.9993 26.5269 14.0219 26.5314 14.0428 26.5404C14.0638 26.5495 14.0825 26.5629 14.0977 26.5799V26.5799ZM10.3152 26.9474L13.254 31.3549L13.8027 26.8486L10.3152 26.9474V26.9474Z' fill='%23CC6228'/%3e%3cpath d='M26.0186 26.6868L26.6286 31.7968L29.9736 26.798L26.0186 26.6855V26.6868Z' fill='%23CC6228'/%3e%3cpath d='M25.9025 26.5806C25.9178 26.5638 25.9365 26.5506 25.9575 26.5417C25.9784 26.5329 26.001 26.5287 26.0237 26.5294L29.9787 26.6419C30.0065 26.6431 30.0335 26.6516 30.057 26.6666C30.0804 26.6816 30.0995 26.7026 30.1122 26.7274C30.1249 26.7521 30.1308 26.7798 30.1293 26.8076C30.1278 26.8354 30.119 26.8623 30.1037 26.8856L26.76 31.8856C26.742 31.9125 26.7163 31.9332 26.6862 31.9449C26.6561 31.9566 26.6231 31.9588 26.5917 31.9512C26.5603 31.9435 26.5321 31.9264 26.5107 31.9022C26.4894 31.8779 26.476 31.8477 26.4725 31.8156L25.8625 26.7056C25.8597 26.6831 25.8619 26.6603 25.8688 26.6388C25.8757 26.6172 25.8872 26.5974 25.9025 26.5806V26.5806ZM26.1975 26.8494L26.735 31.3556L29.685 26.9481L26.1975 26.8481V26.8494Z' fill='%23CC6228'/%3e%3cpath d='M29.0165 21.0547L21.9277 21.3772L22.5865 25.0122L23.6315 22.8159L26.1565 23.9697L29.0165 21.0547V21.0547Z' fill='%23CC6228'/%3e%3cpath d='M29.1602 20.9904C29.1732 21.0193 29.1772 21.0515 29.1716 21.0827C29.166 21.1139 29.1512 21.1427 29.1289 21.1654L26.2689 24.0804C26.2462 24.1036 26.2167 24.1192 26.1847 24.125C26.1527 24.1308 26.1197 24.1266 26.0902 24.1129L23.7064 23.0241L22.7289 25.0791C22.7147 25.1093 22.6911 25.1342 22.6618 25.1502C22.6324 25.1661 22.5987 25.1723 22.5656 25.1679C22.5324 25.1634 22.5016 25.1485 22.4775 25.1254C22.4534 25.1022 22.4372 25.072 22.4314 25.0391L21.7727 21.4054C21.7686 21.3832 21.7692 21.3605 21.7746 21.3386C21.78 21.3167 21.7901 21.2963 21.804 21.2787C21.818 21.261 21.8356 21.2466 21.8557 21.2363C21.8757 21.226 21.8977 21.2202 21.9202 21.2191L29.0089 20.8966C29.0739 20.8941 29.1339 20.9316 29.1589 20.9904H29.1602ZM22.1152 21.5266L22.6539 24.5016L23.4889 22.7479C23.5068 22.7107 23.5386 22.682 23.5774 22.6679C23.6162 22.6539 23.6589 22.6557 23.6964 22.6729L26.1214 23.7804L28.6227 21.2304L22.1152 21.5266V21.5266Z' fill='%23CC6228'/%3e%3cpath d='M13.8564 23.9697L16.3689 22.8159L17.4126 25.0122L18.0726 21.3772L10.9839 21.0547L13.8564 23.9697V23.9697Z' fill='%23CC6228'/%3e%3cpath d='M10.84 20.9903C10.8528 20.9615 10.8739 20.9371 10.9006 20.9204C10.9274 20.9037 10.9585 20.8954 10.99 20.8966L18.0801 21.2191C18.1025 21.2201 18.1245 21.226 18.1446 21.2363C18.1646 21.2465 18.1822 21.261 18.1962 21.2786C18.2102 21.2963 18.2202 21.3167 18.2256 21.3386C18.231 21.3605 18.2317 21.3832 18.2276 21.4053L17.5688 25.0391C17.563 25.072 17.5469 25.1022 17.5228 25.1254C17.4987 25.1485 17.4678 25.1634 17.4347 25.1679C17.4015 25.1723 17.3679 25.1661 17.3385 25.1502C17.3091 25.1342 17.2856 25.1093 17.2713 25.0791L16.2926 23.0241L13.9225 24.1116C13.8932 24.1255 13.8602 24.1299 13.8282 24.1243C13.7962 24.1187 13.7667 24.1034 13.7438 24.0803L10.8713 21.1653C10.8491 21.1427 10.8342 21.1139 10.8286 21.0827C10.823 21.0515 10.827 21.0193 10.84 20.9903V20.9903ZM11.3775 21.2303L13.8901 23.7803L16.3026 22.6728C16.3402 22.6553 16.3833 22.6533 16.4224 22.6674C16.4615 22.6814 16.4934 22.7103 16.5113 22.7478L17.3451 24.5028L17.885 21.5266L11.3775 21.2303Z' fill='%23CC6228'/%3e%3cpath d='M10.9839 21.0547L13.9564 26.8472L13.8564 23.9697L10.9839 21.0547Z' fill='%23E27525'/%3e%3cpath d='M10.8913 20.9258C10.9538 20.8808 11.0413 20.8883 11.0963 20.9433L13.9688 23.8583C13.9964 23.8865 14.0125 23.9239 14.0138 23.9633L14.1138 26.8408C14.1151 26.8766 14.1041 26.9117 14.0827 26.9405C14.0613 26.9692 14.0308 26.9897 13.9961 26.9988C13.9615 27.0078 13.9248 27.0047 13.8921 26.9901C13.8594 26.9755 13.8327 26.9502 13.8163 26.9183L10.8438 21.1258C10.8265 21.0923 10.8217 21.0537 10.8304 21.017C10.8392 20.9803 10.8608 20.9479 10.8913 20.9258V20.9258ZM11.5938 21.8971L13.7738 26.1471L13.7013 24.0346L11.5938 21.8971V21.8971Z' fill='%23E27525'/%3e%3cpath d='M26.1564 23.9697L26.0439 26.8472L29.0164 21.0547L26.1564 23.9697Z' fill='%23E27525'/%3e%3cpath d='M29.1088 20.9264C29.1713 20.9727 29.1926 21.0564 29.1563 21.1264L26.1838 26.9189C26.1675 26.9508 26.1407 26.9761 26.1081 26.9907C26.0754 27.0053 26.0387 27.0084 26.004 26.9994C25.9694 26.9903 25.9388 26.9698 25.9174 26.941C25.896 26.9123 25.8851 26.8772 25.8863 26.8414L25.9988 23.9627C26.0005 23.9237 26.0165 23.8867 26.0438 23.8589L28.9038 20.9439C28.9302 20.9169 28.9654 20.9003 29.0031 20.8971C29.0407 20.8938 29.0782 20.9043 29.1088 20.9264V20.9264ZM26.3113 24.0364L26.2288 26.1414L28.4038 21.9039L26.3113 24.0364Z' fill='%23E27525'/%3e%3cpath d='M18.0723 21.377L17.4136 25.012L18.2461 29.3032L18.4336 23.647L18.0723 21.377V21.377Z' fill='%23E27525'/%3e%3cpath d='M18.0749 21.2188C18.1511 21.22 18.2161 21.2763 18.2286 21.3525L18.5886 23.6225C18.5905 23.6324 18.5913 23.6425 18.5911 23.6525L18.4036 29.3088C18.4029 29.3479 18.3877 29.3853 18.3609 29.4138C18.3342 29.4423 18.2977 29.4598 18.2587 29.463C18.2197 29.4661 18.181 29.4546 18.15 29.4307C18.119 29.4068 18.0981 29.3723 18.0911 29.3338L17.2586 25.0413C17.2549 25.0219 17.2549 25.0019 17.2586 24.9825L17.9174 21.3488C17.9239 21.3119 17.9434 21.2786 17.9722 21.2548C18.0011 21.231 18.0375 21.2182 18.0749 21.2188V21.2188ZM17.5736 25.01L18.1361 27.9025L18.2749 23.6563L18.0624 22.3163L17.5736 25.01V25.01Z' fill='%23E27525'/%3e%3cpath d='M21.9274 21.377L21.5786 23.6345L21.7536 29.3032L22.5861 25.012L21.9274 21.377Z' fill='%23E27525'/%3e%3cpath d='M21.9251 21.2188C22.0026 21.2188 22.0689 21.2725 22.0826 21.3488L22.7414 24.9825C22.7451 25.0019 22.7451 25.0218 22.7414 25.0412L21.9089 29.3325C21.902 29.371 21.881 29.4055 21.85 29.4294C21.819 29.4533 21.7803 29.4648 21.7413 29.4617C21.7023 29.4586 21.6659 29.441 21.6391 29.4125C21.6123 29.384 21.5971 29.3466 21.5964 29.3075L21.4214 23.6387C21.4214 23.63 21.4214 23.62 21.4239 23.61L21.7726 21.3525C21.7783 21.3156 21.7968 21.2819 21.825 21.2574C21.8531 21.2329 21.8891 21.2192 21.9264 21.2188H21.9251ZM21.9401 22.3287L21.7376 23.6437L21.8676 27.8887L22.4264 25.01L21.9401 22.3287Z' fill='%23E27525'/%3e%3cpath d='M22.5877 25.0125L21.7539 29.3038L22.3502 29.725L26.0439 26.8475L26.1564 23.9688L22.5864 25.0113L22.5877 25.0125Z' fill='%23F5841F'/%3e%3cpath d='M26.2527 23.8451C26.2927 23.8763 26.3152 23.9251 26.314 23.9751L26.2015 26.8538C26.2006 26.8766 26.1947 26.8989 26.1844 26.9191C26.174 26.9394 26.1594 26.9572 26.1415 26.9713L22.4477 29.8488C22.4211 29.8696 22.3886 29.8814 22.3548 29.8823C22.321 29.8832 22.2879 29.8732 22.2602 29.8538L21.6627 29.4326C21.6382 29.4149 21.6192 29.3905 21.6081 29.3624C21.597 29.3342 21.5943 29.3035 21.6002 29.2738L22.4327 24.9813C22.4382 24.953 22.4513 24.9266 22.4707 24.9053C22.4901 24.8839 22.515 24.8682 22.5427 24.8601L26.1127 23.8188C26.1365 23.8119 26.1615 23.8106 26.1859 23.8152C26.2102 23.8198 26.2331 23.83 26.2527 23.8451V23.8451ZM22.7252 25.1376L21.929 29.2351L22.3477 29.5301L25.8915 26.7688L25.9915 24.1838L22.724 25.1376H22.7252Z' fill='%23F5841F'/%3e%3cpath d='M13.8564 23.9688L13.9564 26.8475L17.6502 29.725L18.2464 29.3038L17.4139 25.0113L13.8564 23.9688Z' fill='%23F5841F'/%3e%3cpath d='M13.7601 23.8453C13.7798 23.8301 13.803 23.8197 13.8275 23.8152C13.8521 23.8106 13.8774 23.8119 13.9013 23.8191L17.4576 24.8603C17.5138 24.8766 17.5576 24.9228 17.5676 24.9816L18.4013 29.2741C18.4071 29.3039 18.4042 29.3347 18.3929 29.3629C18.3816 29.391 18.3624 29.4153 18.3376 29.4328L17.7401 29.8541C17.7125 29.8736 17.6795 29.8838 17.6457 29.8831C17.6119 29.8825 17.5793 29.871 17.5526 29.8503L13.8588 26.9716C13.8408 26.9574 13.826 26.9394 13.8157 26.9188C13.8053 26.8983 13.7995 26.8758 13.7988 26.8528L13.6988 23.9753C13.698 23.9503 13.7031 23.9255 13.7138 23.9029C13.7244 23.8803 13.7403 23.8606 13.7601 23.8453V23.8453ZM14.0226 24.1828L14.1101 26.7691L17.6538 29.5291L18.0726 29.2341L17.2776 25.1353L14.0213 24.1828H14.0226Z' fill='%23F5841F'/%3e%3cpath d='M22.6626 33.6819L22.6989 32.5044L22.3751 32.2306H17.6251L17.3139 32.5044L17.3389 33.6819L13.3589 31.7969L14.7526 32.9381L17.5751 34.8856H22.4126L25.2476 32.9381L26.6289 31.7969L22.6614 33.6819H22.6626Z' fill='%23C0AC9D'/%3e%3cpath d='M13.2252 31.7127C13.2457 31.6799 13.2775 31.6558 13.3146 31.645C13.3517 31.6341 13.3915 31.6373 13.4264 31.654L17.1764 33.4302L17.1564 32.5065C17.1564 32.4602 17.1752 32.4165 17.2102 32.3852L17.5214 32.1127C17.55 32.0872 17.5869 32.073 17.6252 32.0727H22.3752C22.4127 32.0727 22.4489 32.0852 22.4777 32.1102L22.8002 32.3827C22.8377 32.414 22.8577 32.4602 22.8564 32.5077L22.8277 33.429L26.5614 31.654C26.5961 31.6377 26.6355 31.6346 26.6723 31.6453C26.7091 31.6561 26.7407 31.6798 26.7612 31.7121C26.7817 31.7445 26.7898 31.7832 26.7838 31.821C26.7779 31.8589 26.7584 31.8932 26.7289 31.9177L25.3377 33.0677L22.5027 35.0152C22.4762 35.0333 22.4448 35.0429 22.4127 35.0427H17.5752C17.5431 35.043 17.5116 35.0334 17.4852 35.0152L14.6514 33.0602L13.2589 31.919C13.2293 31.8945 13.2096 31.86 13.2036 31.822C13.1976 31.784 13.2057 31.7451 13.2264 31.7127H13.2252ZM14.4527 32.489L14.8464 32.8115L17.6239 34.7277H22.3639L25.1539 32.8115L25.5502 32.4827L22.7289 33.824C22.7046 33.8355 22.6777 33.8406 22.6509 33.8388C22.624 33.837 22.5981 33.8284 22.5755 33.8137C22.553 33.7991 22.5345 33.7789 22.522 33.755C22.5095 33.7312 22.5032 33.7046 22.5039 33.6777L22.5389 32.5752L22.3177 32.3877H17.6839L17.4727 32.574L17.4964 33.679C17.4969 33.7058 17.4905 33.7322 17.4779 33.7559C17.4652 33.7795 17.4468 33.7995 17.4243 33.8141C17.4017 33.8286 17.3759 33.8371 17.3491 33.8388C17.3224 33.8406 17.2956 33.8354 17.2714 33.824L14.4527 32.489V32.489Z' fill='%23C0AC9D'/%3e%3cpath d='M22.3502 29.7252L21.754 29.3027H18.2465L17.6502 29.7252L17.314 32.504L17.6252 32.2302H22.3752L22.699 32.504L22.3502 29.7252Z' fill='%23161616'/%3e%3cpath d='M18.1549 29.1745C18.1814 29.1553 18.2133 29.1448 18.2461 29.1445H21.7536C21.7861 29.1445 21.8174 29.1558 21.8449 29.1745L22.4411 29.5958C22.4774 29.6208 22.5011 29.6608 22.5061 29.7045L22.8549 32.4833C22.8588 32.5147 22.8531 32.5465 22.8386 32.5746C22.8242 32.6027 22.8016 32.6259 22.7738 32.641C22.746 32.6561 22.7143 32.6625 22.6829 32.6593C22.6514 32.6561 22.6216 32.6436 22.5974 32.6233L22.3174 32.387H17.6836L17.4174 32.6208C17.3934 32.6417 17.3636 32.6549 17.332 32.6586C17.3003 32.6623 17.2683 32.6563 17.2401 32.6414C17.212 32.6265 17.189 32.6034 17.1742 32.5752C17.1594 32.547 17.1536 32.5149 17.1574 32.4833L17.4924 29.7058C17.4951 29.6838 17.5024 29.6627 17.5138 29.6437C17.5252 29.6248 17.5405 29.6084 17.5586 29.5958L18.1549 29.1745V29.1745ZM18.2961 29.4595L17.7974 29.812L17.5199 32.112C17.5488 32.0862 17.5862 32.072 17.6249 32.072H22.3749C22.4124 32.072 22.4486 32.0845 22.4774 32.1095L22.4924 32.122L22.2024 29.8133L21.7024 29.4595H18.2961V29.4595Z' fill='%23161616'/%3e%3cpath d='M35.0348 15.0252L36.0923 9.89023L34.5011 5.11523L22.3511 14.1077L27.0261 18.0527L33.6298 19.9752L35.0848 18.2752L34.4511 17.8165L35.4586 16.899L34.6873 16.304L35.6948 15.5352L35.0348 15.0265V15.0252Z' fill='%23763E1A'/%3e%3cpath d='M34.5486 4.96548C34.5722 4.97303 34.5936 4.98602 34.6112 5.00339C34.6288 5.02077 34.6421 5.04204 34.6499 5.06548L36.2424 9.84048C36.2509 9.86717 36.2522 9.89563 36.2461 9.92298L35.2086 14.9605L35.7911 15.4105C35.8103 15.4252 35.8259 15.4441 35.8366 15.4658C35.8473 15.4875 35.8528 15.5113 35.8528 15.5355C35.8528 15.5597 35.8473 15.5835 35.8366 15.6052C35.8259 15.6269 35.8103 15.6458 35.7911 15.6605L34.9461 16.3042L35.5549 16.7742C35.5731 16.7883 35.5881 16.8061 35.5987 16.8266C35.6093 16.847 35.6152 16.8695 35.6162 16.8925C35.6172 16.9155 35.6131 16.9385 35.6042 16.9597C35.5953 16.9809 35.5819 17 35.5649 17.0155L34.6999 17.803L35.1774 18.148C35.1952 18.1607 35.2102 18.1771 35.2214 18.1959C35.2325 18.2148 35.2396 18.2358 35.2422 18.2575C35.2448 18.2793 35.2428 18.3014 35.2364 18.3223C35.23 18.3433 35.2192 18.3627 35.2049 18.3792L33.7499 20.0792C33.73 20.102 33.704 20.1186 33.675 20.1271C33.646 20.1355 33.6151 20.1354 33.5861 20.1267L26.9824 18.2042C26.9613 18.1979 26.9417 18.1873 26.9249 18.173L22.2499 14.2292C22.2315 14.214 22.2169 14.1949 22.207 14.1732C22.1971 14.1515 22.1923 14.1278 22.1929 14.104C22.1935 14.0801 22.1995 14.0568 22.2105 14.0356C22.2214 14.0144 22.237 13.996 22.2561 13.9817L34.4061 4.98923C34.4262 4.97398 34.4496 4.96375 34.4744 4.9594C34.4992 4.95505 34.5246 4.95671 34.5486 4.96423V4.96548ZM22.6049 14.1155L27.1024 17.9105L33.5774 19.7955L34.8549 18.303L34.3586 17.9442C34.3397 17.9305 34.3241 17.9127 34.3129 17.8922C34.3017 17.8717 34.2952 17.849 34.2939 17.8256C34.2926 17.8023 34.2965 17.779 34.3053 17.7573C34.3141 17.7357 34.3276 17.7163 34.3449 17.7005L35.2136 16.9092L34.5911 16.4292C34.572 16.4145 34.5564 16.3956 34.5457 16.3739C34.535 16.3523 34.5295 16.3284 34.5295 16.3042C34.5295 16.2801 34.535 16.2562 34.5457 16.2345C34.5564 16.2129 34.572 16.1939 34.5911 16.1792L35.4361 15.5342L34.9386 15.1505C34.9154 15.1324 34.8977 15.1082 34.8876 15.0806C34.8774 15.053 34.8752 15.023 34.8811 14.9942L35.9299 9.90048L34.4199 5.37048L22.6036 14.1167L22.6049 14.1155Z' fill='%23763E1A'/%3e%3cpath d='M3.90869 9.89219L4.97744 15.0272L4.29369 15.5359L5.31369 16.3047L4.54244 16.9009L5.54994 17.8184L4.91494 18.2772L6.36994 19.9772L12.9737 18.0547L17.6499 14.1097L5.49994 5.11719L3.90869 9.89219V9.89219Z' fill='%23763E1A'/%3e%3cpath d='M5.45232 4.96405C5.47589 4.95677 5.50083 4.95512 5.52515 4.95925C5.54947 4.96338 5.57247 4.97315 5.59232 4.9878L17.7423 13.9803C17.7616 13.9944 17.7774 14.0126 17.7886 14.0337C17.7997 14.0548 17.806 14.0781 17.8068 14.1019C17.8077 14.1258 17.8031 14.1495 17.7934 14.1713C17.7838 14.1931 17.7693 14.2124 17.7511 14.2278L13.0761 18.1716C13.0589 18.186 13.0389 18.1967 13.0173 18.2028L6.41357 20.1241C6.38466 20.1323 6.35399 20.1321 6.32519 20.1234C6.2964 20.1148 6.27068 20.0981 6.25107 20.0753L4.79482 18.3753C4.78068 18.3588 4.77012 18.3395 4.76381 18.3186C4.7575 18.2978 4.75558 18.2759 4.75816 18.2543C4.76075 18.2327 4.76778 18.2118 4.77882 18.1931C4.78987 18.1743 4.80468 18.158 4.82232 18.1453L5.29982 17.8003L4.43607 17.0128C4.41898 16.9974 4.40548 16.9784 4.39651 16.9572C4.38754 16.936 4.38332 16.9131 4.38416 16.8901C4.38499 16.8671 4.39086 16.8446 4.40134 16.8241C4.41182 16.8036 4.42666 16.7857 4.44482 16.7716L5.05357 16.3028L4.19857 15.6578C4.17891 15.6431 4.16295 15.6241 4.15196 15.6022C4.14096 15.5803 4.13524 15.5561 4.13524 15.5316C4.13524 15.507 4.14096 15.4828 4.15196 15.4609C4.16295 15.439 4.17891 15.42 4.19857 15.4053L4.80232 14.9566L3.75232 9.9203C3.74661 9.89285 3.74834 9.86436 3.75732 9.8378L5.34982 5.0628C5.35779 5.03922 5.37123 5.01786 5.38905 5.00048C5.40686 4.98309 5.42855 4.97018 5.45232 4.9628V4.96405ZM5.57982 5.36905L4.06982 9.89905L5.13107 14.9928C5.13727 15.0222 5.13491 15.0528 5.12428 15.081C5.11365 15.1091 5.09518 15.1336 5.07107 15.1516L4.55607 15.5341L5.40732 16.1766C5.42658 16.1912 5.44221 16.21 5.45302 16.2316C5.46382 16.2533 5.46951 16.2771 5.46963 16.3012C5.46975 16.3254 5.4643 16.3493 5.45372 16.371C5.44313 16.3928 5.42768 16.4118 5.40857 16.4266L4.78607 16.9078L5.65482 17.6991C5.67214 17.7147 5.68576 17.7341 5.69469 17.7557C5.70361 17.7773 5.70762 17.8006 5.70643 17.8239C5.70523 17.8472 5.69886 17.87 5.68777 17.8906C5.67668 17.9111 5.66116 17.929 5.64232 17.9428L5.14607 18.3016L6.42357 19.7941L12.8973 17.9091L17.3948 14.1153L5.57982 5.36905V5.36905Z' fill='%23763E1A'/%3e%3cpath d='M33.6302 19.9752L27.0264 18.0527L29.0164 21.054L26.0439 26.8477L29.9739 26.7977H35.8439L33.6314 19.9752H33.6302Z' fill='%23F5841F'/%3e%3cpath d='M26.9002 17.9582C26.9193 17.9324 26.9458 17.9131 26.9762 17.9028C27.0066 17.8926 27.0394 17.8918 27.0702 17.9007L33.6739 19.8232C33.7239 19.8382 33.7639 19.8757 33.7802 19.9257L35.9927 26.7482C36.0003 26.7717 36.0023 26.7968 35.9985 26.8212C35.9947 26.8457 35.9851 26.869 35.9706 26.889C35.9561 26.9091 35.9371 26.9255 35.9151 26.9369C35.8931 26.9482 35.8687 26.9543 35.8439 26.9544H29.9752L26.0464 27.0044C26.0192 27.0049 25.9922 26.9983 25.9683 26.9852C25.9443 26.9721 25.9242 26.9531 25.9098 26.9299C25.8955 26.9067 25.8874 26.8802 25.8863 26.8529C25.8853 26.8257 25.8914 26.7986 25.9039 26.7744L28.8339 21.0632L26.8964 18.1382C26.8786 18.1114 26.8694 18.0798 26.87 18.0476C26.8707 18.0154 26.8812 17.9842 26.9002 17.9582V17.9582ZM27.3952 18.3232L29.1477 20.9669C29.1631 20.9902 29.172 21.0172 29.1735 21.0451C29.1751 21.073 29.1692 21.1008 29.1564 21.1257L26.3039 26.6857L29.9739 26.6394H35.6277L33.5064 20.1019L27.3952 18.3232V18.3232Z' fill='%23F5841F'/%3e%3cpath d='M12.9739 18.0527L6.3702 19.9752L4.16895 26.7977H10.0252L13.9552 26.8477L10.9827 21.054L12.9727 18.0527H12.9739Z' fill='%23F5841F'/%3e%3cpath d='M13.1002 17.9582C13.1402 18.0119 13.1415 18.0832 13.1052 18.1394L11.1665 21.0644L14.0965 26.7744C14.109 26.7986 14.1151 26.8257 14.114 26.8529C14.113 26.8802 14.1049 26.9067 14.0905 26.9299C14.0762 26.9531 14.056 26.9721 14.0321 26.9852C14.0082 26.9983 13.9812 27.0049 13.954 27.0044L10.0252 26.9544H4.16897C4.14408 26.9544 4.11955 26.9486 4.09737 26.9373C4.07518 26.926 4.05599 26.9097 4.04135 26.8895C4.02672 26.8694 4.01706 26.8461 4.01317 26.8215C4.00928 26.797 4.01126 26.7718 4.01897 26.7482L6.21896 19.9257C6.22707 19.9011 6.24112 19.8788 6.25987 19.8609C6.27862 19.8431 6.3015 19.8301 6.32646 19.8232L12.9302 17.9007C12.961 17.8918 12.9938 17.8926 13.0242 17.9028C13.0546 17.9131 13.0811 17.9324 13.1002 17.9582V17.9582ZM6.49396 20.1019L4.38522 26.6394H10.0277L13.6965 26.6857L10.844 21.1257C10.8312 21.1008 10.8253 21.073 10.8268 21.0451C10.8284 21.0172 10.8373 20.9902 10.8527 20.9669L12.6052 18.3232L6.49396 20.1019V20.1019Z' fill='%23F5841F'/%3e%3cpath d='M21.9276 21.3768L22.3501 14.108L24.2651 8.93555H15.7339L17.6501 14.108L18.0726 21.3768L18.2351 23.6593L18.2476 29.3031H21.7539L21.7664 23.6593L21.9276 21.3768V21.3768Z' fill='%23F5841F'/%3e%3cpath d='M15.6052 8.84485C15.6196 8.82408 15.6389 8.8071 15.6613 8.79536C15.6837 8.78361 15.7086 8.77743 15.7339 8.77735H24.2652C24.2907 8.77716 24.3159 8.78317 24.3386 8.79488C24.3612 8.80658 24.3807 8.82362 24.3954 8.84452C24.41 8.86543 24.4193 8.88958 24.4226 8.9149C24.4258 8.94021 24.4228 8.96593 24.4139 8.98985L22.5064 14.1399L22.0852 21.3874L21.9227 23.6649L21.9102 29.3024C21.9102 29.3899 21.8402 29.4611 21.7539 29.4611H18.2464C18.2047 29.4611 18.1646 29.4445 18.1351 29.415C18.1055 29.3854 18.0889 29.3454 18.0889 29.3036L18.0764 23.6649L17.9152 21.3874V21.3861L17.4939 14.1399L15.5864 8.98985C15.5776 8.96596 15.5747 8.94029 15.578 8.91504C15.5812 8.88979 15.5906 8.8657 15.6052 8.84485V8.84485ZM15.9602 9.09235L17.7977 14.0523C17.8029 14.0672 17.8058 14.0828 17.8064 14.0986L18.2302 21.3661V21.3674L18.3927 23.6586L18.4039 29.1461H21.5964L21.6089 23.6474L21.7714 21.3674V21.3649L22.1927 14.0986C22.1939 14.0836 22.1977 14.0673 22.2027 14.0523L24.0402 9.09235H15.9614H15.9602Z' fill='%23F5841F'/%3e%3c/svg%3e";

let instance;
const switchWalletNotice = (type) => {
    if (isInSameOriginIframe()) {
        return;
    }
    const titles = {
        unhosted: "Unhosted",
        metamask: "MetaMask",
    };
    if (instance) {
        instance.hide();
        instance = null;
    }
    instance = notice({
        closeable: true,
        timeout: 0,
        className: "unhosted-notice-default-wallet",
        content: `<div style="display: flex; align-items: center; gap: 12px; color: #13141A;">
      <img style="width: 28px;" src="${type === "unhosted" ? img$4 : img}"/>
      <div style="color: #13141A;">
        <div style="color: #13141A;"><span style="font-weight: bold; color: #13141A;">${titles[type]}</span> is your default wallet now. </div>
        <div style="color: #13141A;">
        Please <a
          href="javascript:window.location.reload();"
          style="color: #8697FF; text-decoration: underline;">refresh the web page</a> 
        and retry
        </div>
      </div>
    </div>
    `,
    });
};

// keep isMetaMask and remove isUnhosted
const impersonateMetamaskWhitelist = [
    // layerzero
    "bitcoinbridge.network",
    "bridge.liquidswap.com",
    "theaptosbridge.com",
    "app.actafi.org",
    "bridge.linea.build",
    "bridge.coredao.org",
    // rainbow
    "telx.network",
];
// keep isUnhosted and remove isMetaMask
const unhostedHostList = [];
/**
 * Detect current host is includes target host
 * @param current
 * @param target
 * @returns
 */
const isIncludesHost = (current, target) => {
    return current === target || current.endsWith(`.${target}`);
};
const isInHostList = (list, host) => {
    return list.some((target) => isIncludesHost(host, target));
};
const getProviderMode = (host) => {
    if (isInHostList(impersonateMetamaskWhitelist, host)) {
        return "metamask";
    }
    if (isInHostList(unhostedHostList, host)) {
        return "unhosted";
    }
    return "default";
};
const patchProvider = (provider) => {
    const mode = getProviderMode(window.location.hostname);
    try {
        if (mode === "metamask") {
            delete provider.isUnhosted;
            provider.isMetaMask = true;
            return;
        }
        if (mode === "unhosted") {
            delete provider.isMetaMask;
            provider.isUnhosted = true;
            return;
        }
        if (mode === "default") {
            provider.isMetaMask = true;
            provider.isUnhosted = true;
            return;
        }
    }
    catch (e) {
        console.error(e);
    }
};

// this script is injected into webpage's context
const log = (event, ...args) => {
    if (process.env.NODE_ENV !== "production") {
        console.log(`%c [unhosted] (${new Date().toTimeString().substr(0, 8)}) ${event}`, "font-weight: bold; background-color: #7d6ef9; color: white;", ...args);
    }
};
let channelName = typeof __unhosted__channelName !== "undefined" ? __unhosted__channelName : "";
typeof __unhosted__isDefaultWallet !== "undefined"
    ? __unhosted__isDefaultWallet
    : false;
let isOpera = typeof __unhosted__isOpera !== "undefined" ? __unhosted__isOpera : false;
let uuid = typeof __unhosted__uuid !== "undefined" ? __unhosted__uuid : "";
const getParams = () => {
    if (localStorage.getItem("unhosted:channelName")) {
        channelName = localStorage.getItem("unhosted:channelName");
        localStorage.removeItem("unhosted:channelName");
    }
    if (localStorage.getItem("unhosted:isDefaultWallet")) {
        localStorage.getItem("unhosted:isDefaultWallet") === "true";
        localStorage.removeItem("unhosted:isDefaultWallet");
    }
    if (localStorage.getItem("unhosted:uuid")) {
        uuid = localStorage.getItem("unhosted:uuid");
        localStorage.removeItem("unhosted:uuid");
    }
    if (localStorage.getItem("unhosted:isOpera")) {
        isOpera = localStorage.getItem("unhosted:isOpera") === "true";
        localStorage.removeItem("unhosted:isOpera");
    }
};
getParams();
class EthereumProvider extends events.EventEmitter {
    constructor({ maxListeners = 100 } = {}) {
        super();
        this.chainId = null;
        this.selectedAddress = null;
        /**
         * The network ID of the currently connected Ethereum chain.
         * @deprecated
         */
        this.networkVersion = null;
        this.isUnhosted = true;
        this.isMetaMask = true;
        this._isUnhosted = true;
        this._isReady = false;
        this._isConnected = false;
        this._initialized = false;
        this._isUnlocked = false;
        this._cacheRequestsBeforeReady = [];
        this._cacheEventListenersBeforeReady = [];
        this._state = {
            accounts: null,
            isConnected: false,
            isUnlocked: false,
            initialized: false,
            isPermanentlyDisconnected: false,
        };
        this._metamask = {
            isUnlocked: () => {
                return new Promise((resolve) => {
                    resolve(this._isUnlocked);
                });
            },
        };
        this._requestPromise = new ReadyPromise(2);
        this._dedupePromise = new DedupePromise([]);
        this._bcm = new BroadcastChannelMessage(channelName);
        this.initialize = async () => {
            document.addEventListener("visibilitychange", this._requestPromiseCheckVisibility);
            this._bcm.connect().on("message", this._handleBackgroundMessage);
            domReadyCall(() => {
                var _a, _b, _c;
                const origin = location.origin;
                const icon = ((_a = $('head > link[rel~="icon"]')) === null || _a === void 0 ? void 0 : _a.href) ||
                    ((_b = $('head > meta[itemprop="image"]')) === null || _b === void 0 ? void 0 : _b.content);
                const name = document.title ||
                    ((_c = $('head > meta[name="title"]')) === null || _c === void 0 ? void 0 : _c.content) ||
                    origin;
                this._bcm.request({
                    method: "tabCheckin",
                    params: { icon, name, origin },
                });
                this._requestPromise.check(2);
            });
            try {
                const { chainId, accounts, networkVersion, isUnlocked } = await this.requestInternalMethods({
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
            }
            catch {
                //
            }
            finally {
                this._initialized = true;
                this._state.initialized = true;
                this.emit("_initialized");
            }
        };
        this._requestPromiseCheckVisibility = () => {
            if (document.visibilityState === "visible") {
                this._requestPromise.check(1);
            }
            else {
                this._requestPromise.uncheck(1);
            }
        };
        this._handleBackgroundMessage = ({ event, data }) => {
            log("[push event]", event, data);
            if (this._pushEventHandlers[event]) {
                return this._pushEventHandlers[event](data);
            }
            this.emit(event, data);
        };
        this.isConnected = () => {
            return true;
        };
        // TODO: support multi request!
        this.request = async (data) => {
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
        this._request = async (data) => {
            if (!data) {
                throw ethRpcErrors.ethErrors.rpc.invalidRequest();
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
                        log("[request: error]", data.method, ethRpcErrors.serializeError(err));
                    }
                    throw ethRpcErrors.serializeError(err);
                });
            });
        };
        this.requestInternalMethods = (data) => {
            return this._dedupePromise.call(data.method, () => this._request(data));
        };
        // shim to matamask legacy api
        this.sendAsync = (payload, callback) => {
            if (Array.isArray(payload)) {
                return Promise.all(payload.map((item) => new Promise((resolve) => {
                    this.sendAsync(item, (err, res) => {
                        // ignore error
                        resolve(res);
                    });
                }))).then((result) => callback(null, result));
            }
            const { method, params, ...rest } = payload;
            this.request({ method, params })
                .then((result) => callback(null, { ...rest, method, result }))
                .catch((error) => callback(error, { ...rest, method, error }));
        };
        this.send = (payload, callback) => {
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
        this.shimLegacy = () => {
            const legacyMethods = [
                ["enable", "eth_requestAccounts"],
                ["net_version", "net_version"],
            ];
            for (const [_method, method] of legacyMethods) {
                this[_method] = () => this.request({ method });
            }
        };
        this.on = (event, handler) => {
            if (!this._isReady) {
                this._cacheEventListenersBeforeReady.push([event, handler]);
                return this;
            }
            return super.on(event, handler);
        };
        this.setMaxListeners(maxListeners);
        this.initialize();
        this.shimLegacy();
        this._pushEventHandlers = new PushEventHandlers(this);
    }
}
const provider = new EthereumProvider();
patchProvider(provider);
const unhostedProvider = new Proxy(provider, {
    deleteProperty: (target, prop) => {
        if (typeof prop === "string" &&
            ["on", "isUnhosted", "isMetaMask", "_isUnhosted"].includes(prop)) {
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
    });
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
                        setDefaultProvider(unhostedAsDefault) {
                            var _a;
                            if (unhostedAsDefault) {
                                window.unhostedWalletRouter.currentProvider = window.unhosted;
                            }
                            else {
                                const nonDefaultProvider = (_a = window.unhostedWalletRouter.lastInjectedProvider) !== null && _a !== void 0 ? _a : window.ethereum;
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
        }
        catch (e) {
            // think that defineProperty failed means there is any other wallet
            requestHasOtherProvider();
            console.error(e);
            window.ethereum = unhostedProvider;
            window.unhosted = unhostedProvider;
        }
    }
    else {
        window.ethereum = unhostedProvider;
        window.unhosted = unhostedProvider;
    }
};
if (isOpera) {
    initOperaProvider();
}
else {
    initProvider();
}
requestIsDefaultWallet().then((unhostedAsDefault) => {
    var _a;
    (_a = window.unhostedWalletRouter) === null || _a === void 0 ? void 0 : _a.setDefaultProvider(unhostedAsDefault);
    if (unhostedAsDefault) {
        window.ethereum = unhostedProvider;
        unhostedProvider.on("unhosted:chainChanged", switchChainNotice);
    }
});
const announceEip6963Provider = (provider) => {
    const info = {
        uuid: uuid,
        name: "Unhosted Wallet",
        icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGcgY2xpcC1wYXRoPSJ1cmwoI2NsaXAwXzc0MV8yNzUxKSI+CjxtYXNrIGlkPSJtYXNrMF83NDFfMjc1MSIgc3R5bGU9Im1hc2stdHlwZTpsdW1pbmFuY2UiIG1hc2tVbml0cz0idXNlclNwYWNlT25Vc2UiIHg9IjAiIHk9IjAiIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+CjxwYXRoIGQ9Ik0zMiAxNkMzMiA3LjE2MzQ0IDI0LjgzNjYgMCAxNiAwQzcuMTYzNDQgMCAwIDcuMTYzNDQgMCAxNkMwIDI0LjgzNjYgNy4xNjM0NCAzMiAxNiAzMkMyNC44MzY2IDMyIDMyIDI0LjgzNjYgMzIgMTZaIiBmaWxsPSJ3aGl0ZSIvPgo8L21hc2s+CjxnIG1hc2s9InVybCgjbWFzazBfNzQxXzI3NTEpIj4KPHBhdGggZD0iTTMyIDE2QzMyIDcuMTYzNDQgMjQuODM2NiAwIDE2IDBDNy4xNjM0NCAwIDAgNy4xNjM0NCAwIDE2QzAgMjQuODM2NiA3LjE2MzQ0IDMyIDE2IDMyQzI0LjgzNjYgMzIgMzIgMjQuODM2NiAzMiAxNloiIGZpbGw9IiM3MDg0RkYiLz4KPGcgZmlsdGVyPSJ1cmwoI2ZpbHRlcjBfZF83NDFfMjc1MSkiPgo8cGF0aCBkPSJNMjcuNjAxOSAxNy4zODc2QzI4LjUyMTYgMTUuMzI2MSAyMy45NzQ4IDkuNTY2MzIgMTkuNjMxIDcuMTY2NzZDMTYuODkyOSA1LjMwNzc5IDE0LjAzOTkgNS41NjMxOCAxMy40NjIgNi4zNzkzOEMxMi4xOTQgOC4xNzA2OSAxNy42NjExIDkuNjg4NTEgMjEuMzE3NCAxMS40NTk3QzIwLjUzMTQgMTEuODAyMiAxOS43OTA4IDEyLjQxNjkgMTkuMzU1MiAxMy4yMDI5QzE3Ljk5MjEgMTEuNzA5OCAxNS4wMDAzIDEwLjQyMzkgMTEuNDg5NyAxMS40NTk3QzkuMTIzOTcgMTIuMTU3NyA3LjE1NzkxIDEzLjgwMzIgNi4zOTgwNCAxNi4yODg1QzYuMjEzMzcgMTYuMjA2MiA2LjAwODk0IDE2LjE2MDQgNS43OTM4NyAxNi4xNjA0QzQuOTcxNDIgMTYuMTYwNCA0LjMwNDY5IDE2LjgyOTQgNC4zMDQ2OSAxNy42NTQ2QzQuMzA0NjkgMTguNDc5OSA0Ljk3MTQyIDE5LjE0ODggNS43OTM4NyAxOS4xNDg4QzUuOTQ2MzIgMTkuMTQ4OCA2LjQyMjk4IDE5LjA0NjMgNi40MjI5OCAxOS4wNDYzTDE0LjAzOTkgMTkuMTAxNkMxMC45OTM3IDIzLjk1MDQgOC41ODYzNSAyNC42NTkxIDguNTg2MzUgMjUuNDk5MkM4LjU4NjM1IDI2LjMzOTIgMTAuODg5OCAyNi4xMTE2IDExLjc1NDcgMjUuNzk4NEMxNS44OTQ5IDI0LjI5OTUgMjAuMzQxNyAxOS42MjggMjEuMTA0OCAxOC4yODMzQzI0LjMwOTIgMTguNjg0NCAyNy4wMDIyIDE4LjczMTggMjcuNjAxOSAxNy4zODc2WiIgZmlsbD0idXJsKCNwYWludDBfbGluZWFyXzc0MV8yNzUxKSIvPgo8cGF0aCBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGNsaXAtcnVsZT0iZXZlbm9kZCIgZD0iTTIxLjMwMjkgMTEuNDUzOEMyMS4zMDY3IDExLjQ1NTUgMjEuMzEwNiAxMS40NTcxIDIxLjMxNDQgMTEuNDU4OEMyMS40ODM5IDExLjM5MTggMjEuNDU2NSAxMS4xNDA3IDIxLjQwOTkgMTAuOTQzNUMyMS4zMDMgMTAuNDkwMSAxOS40NTc1IDguNjYxNjUgMTcuNzI0NSA3Ljg0MjY1QzE1LjM2MjkgNi43MjY2NSAxMy42MjQgNi43ODQyMSAxMy4zNjcyIDcuMjk4NjVDMTMuODQ3MiA4LjI4ODIxIDE2LjA3NzkgOS4yMTcyNyAxOC40MDc3IDEwLjE4NzZDMTkuMzk3MSAxMC41OTk2IDIwLjQwNDMgMTEuMDE5MSAyMS4zMDI5IDExLjQ1MzhaIiBmaWxsPSJ1cmwoI3BhaW50MV9saW5lYXJfNzQxXzI3NTEpIi8+CjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBkPSJNMTguMzIyOCAyMS40MTY3QzE3Ljg0NTMgMjEuMjMzNyAxNy4zMDYgMjEuMDY1OCAxNi42OTI5IDIwLjkxMzNDMTcuMzQ2OSAxOS43MzkzIDE3LjQ4NDEgMTguMDAxMSAxNi44NjY1IDE2LjkwMjJDMTUuOTk5OCAxNS4zNTk5IDE0LjkxMTcgMTQuNTM5MSAxMi4zODM0IDE0LjUzOTFDMTAuOTkyOCAxNC41MzkxIDcuMjQ4NzcgMTUuMDA5IDcuMTgyMjcgMTguMTQ1QzcuMTc1MzQgMTguNDczOCA3LjE4MjA5IDE4Ljc3NTEgNy4yMDU3NyAxOS4wNTIxTDE0LjA0MyAxOS4xMDE5QzEzLjEyMSAyMC41Njk0IDEyLjI1NzUgMjEuNjU3NyAxMS41MDE2IDIyLjQ4NTJDMTIuNDA5MiAyMi43MTg2IDEzLjE1ODEgMjIuOTE0NCAxMy44NDU3IDIzLjA5NDNDMTQuNDk3OCAyMy4yNjQ4IDE1LjA5NDYgMjMuNDIwOSAxNS43MTkzIDIzLjU4MDlDMTYuNjYyIDIyLjg5MTggMTcuNTQ4MyAyMi4xNDA0IDE4LjMyMjggMjEuNDE2N1oiIGZpbGw9InVybCgjcGFpbnQyX2xpbmVhcl83NDFfMjc1MSkiLz4KPHBhdGggZD0iTTYuMzA4NzQgMTguNzI4M0M2LjU4ODA1IDIxLjExMDUgNy45MzczNiAyMi4wNDQxIDEwLjY5NDYgMjIuMzIwNUMxMy40NTE5IDIyLjU5NjggMTUuMDMzNSAyMi40MTE0IDE3LjEzOTEgMjIuNjAzNkMxOC44OTc3IDIyLjc2NDEgMjAuNDY4IDIzLjY2MzMgMjEuMDUwNSAyMy4zNTI2QzIxLjU3NDcgMjMuMDczIDIxLjI4MTQgMjIuMDYyNiAyMC41Nzk5IDIxLjQxNDRDMTkuNjcwNiAyMC41NzQxIDE4LjQxMjEgMTkuOTkgMTYuMTk3NyAxOS43ODI2QzE2LjYzOSAxOC41NzAyIDE2LjUxNTQgMTYuODcwMyAxNS44Mjk5IDE1Ljk0NTVDMTQuODM4OSAxNC42MDgyIDEzLjAwOTcgMTQuMDAzNiAxMC42OTQ2IDE0LjI2NzhDOC4yNzU4NiAxNC41NDM4IDUuOTU4MjEgMTUuNzM4NiA2LjMwODc0IDE4LjcyODNaIiBmaWxsPSJ1cmwoI3BhaW50M19saW5lYXJfNzQxXzI3NTEpIi8+CjwvZz4KPC9nPgo8L2c+CjxkZWZzPgo8ZmlsdGVyIGlkPSJmaWx0ZXIwX2RfNzQxXzI3NTEiIHg9Ii03Ny42MTUzIiB5PSItNzYuMTYwMiIgd2lkdGg9IjE4Ny4yNTQiIGhlaWdodD0iMTg0LjE2MiIgZmlsdGVyVW5pdHM9InVzZXJTcGFjZU9uVXNlIiBjb2xvci1pbnRlcnBvbGF0aW9uLWZpbHRlcnM9InNSR0IiPgo8ZmVGbG9vZCBmbG9vZC1vcGFjaXR5PSIwIiByZXN1bHQ9IkJhY2tncm91bmRJbWFnZUZpeCIvPgo8ZmVDb2xvck1hdHJpeCBpbj0iU291cmNlQWxwaGEiIHR5cGU9Im1hdHJpeCIgdmFsdWVzPSIwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAwIDAgMCAxMjcgMCIgcmVzdWx0PSJoYXJkQWxwaGEiLz4KPGZlT2Zmc2V0Lz4KPGZlR2F1c3NpYW5CbHVyIHN0ZERldmlhdGlvbj0iNDAuOTYiLz4KPGZlQ29tcG9zaXRlIGluMj0iaGFyZEFscGhhIiBvcGVyYXRvcj0ib3V0Ii8+CjxmZUNvbG9yTWF0cml4IHR5cGU9Im1hdHJpeCIgdmFsdWVzPSIwIDAgMCAwIDAuMTUxOTMzIDAgMCAwIDAgMC4yMzkyMzggMCAwIDAgMCAwLjQ5MDI0MSAwIDAgMCAwLjU0IDAiLz4KPGZlQmxlbmQgbW9kZT0ibm9ybWFsIiBpbjI9IkJhY2tncm91bmRJbWFnZUZpeCIgcmVzdWx0PSJlZmZlY3QxX2Ryb3BTaGFkb3dfNzQxXzI3NTEiLz4KPGZlQmxlbmQgbW9kZT0ibm9ybWFsIiBpbj0iU291cmNlR3JhcGhpYyIgaW4yPSJlZmZlY3QxX2Ryb3BTaGFkb3dfNzQxXzI3NTEiIHJlc3VsdD0ic2hhcGUiLz4KPC9maWx0ZXI+CjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl83NDFfMjc1MSIgeDE9IjExLjIxNDIiIHkxPSIxNS41NjIiIHgyPSIyNy40MTE5IiB5Mj0iMjAuMTM5OSIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSJ3aGl0ZSIvPgo8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IndoaXRlIi8+CjwvbGluZWFyR3JhZGllbnQ+CjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQxX2xpbmVhcl83NDFfMjc1MSIgeDE9IjI0LjY3NDUiIHkxPSIxNS4yNTE4IiB4Mj0iMTIuOTUzNiIgeTI9IjMuNTQxNjMiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KPHN0b3Agc3RvcC1jb2xvcj0iIzg2OTdGRiIvPgo8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM4Njk3RkYiIHN0b3Atb3BhY2l0eT0iMCIvPgo8L2xpbmVhckdyYWRpZW50Pgo8bGluZWFyR3JhZGllbnQgaWQ9InBhaW50Ml9saW5lYXJfNzQxXzI3NTEiIHgxPSIxOC42NDc4IiB5MT0iMjEuODI2MSIgeDI9IjcuNDA4MDIiIHkyPSIxNS4zODU5IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CjxzdG9wIHN0b3AtY29sb3I9IiM4Njk3RkYiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjODY5N0ZGIiBzdG9wLW9wYWNpdHk9IjAiLz4KPC9saW5lYXJHcmFkaWVudD4KPGxpbmVhckdyYWRpZW50IGlkPSJwYWludDNfbGluZWFyXzc0MV8yNzUxIiB4MT0iMTIuMTgyNyIgeTE9IjE1LjQzOTQiIHgyPSIxOS43OTkxIiB5Mj0iMjUuMDg0MyIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSJ3aGl0ZSIvPgo8c3RvcCBvZmZzZXQ9IjAuOTgzODk1IiBzdG9wLWNvbG9yPSIjRDFEOEZGIi8+CjwvbGluZWFyR3JhZGllbnQ+CjxjbGlwUGF0aCBpZD0iY2xpcDBfNzQxXzI3NTEiPgo8cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIGZpbGw9IndoaXRlIi8+CjwvY2xpcFBhdGg+CjwvZGVmcz4KPC9zdmc+Cg==",
        rdns: "io.unhosted",
    };
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({ info, provider }),
    }));
};
window.addEventListener("eip6963:requestProvider", (event) => {
    announceEip6963Provider(unhostedProvider);
});
announceEip6963Provider(unhostedProvider);
window.dispatchEvent(new Event("ethereum#initialized"));

exports.EthereumProvider = EthereumProvider;
