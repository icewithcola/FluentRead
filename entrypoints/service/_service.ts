import {services} from "../utils/option";
import custom from "./custom";
import google from "./google";
import chromeTranslator from "./chrome-translator";

type ServiceFunction = (message: any) => Promise<any>;
type ServiceMap = {[key: string]: ServiceFunction;};

export const _service: ServiceMap = {
    // 传统机器翻译
    [services.google]: google,
    [services.chromeTranslator]: chromeTranslator,

    // 大模型翻译
    [services.custom]: custom,
}
