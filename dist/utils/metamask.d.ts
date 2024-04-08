export declare const calcIsGray: (host: string, ratio: number) => boolean;
type Mode = "metamask" | "unhosted" | "default";
export declare const getProviderMode: (host: string) => Mode;
export declare const patchProvider: (provider: any) => void;
export {};
