import IconMetamask from "../../assets/metamask.svg";
import IconUnhosted from "../../assets/unhosted.svg";
import notice from "../notice";
import { isInSameOriginIframe } from "../../utils/iframe";

let instance: ReturnType<typeof notice> | null;

export const switchWalletNotice = (type: "unhosted" | "metamask") => {
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
      <img style="width: 28px;" src="${
        type === "unhosted" ? IconUnhosted : IconMetamask
      }"/>
      <div style="color: #13141A;">
        <div style="color: #13141A;"><span style="font-weight: bold; color: #13141A;">${
          titles[type]
        }</span> is your default wallet now. </div>
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
