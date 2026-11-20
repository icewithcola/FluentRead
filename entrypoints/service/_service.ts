import { services } from '../utils/option';
import custom from './custom';
import google from './google';
import chromeTranslator from './chrome-translator';

type ServiceFunction = (message: any, signal?: AbortSignal) => Promise<any>;
type ServiceMap = { [key: string]: ServiceFunction };

const chromeTranslatorService: ServiceFunction = import.meta.env.FIREFOX
  ? async () => {
      throw new Error('Chrome Translation API 仅在 Google Chrome 中可用');
    }
  : chromeTranslator;

export const _service: ServiceMap = {
  // 传统机器翻译
  [services.google]: google,
  [services.chromeTranslator]: chromeTranslatorService,

  // 大模型翻译
  [services.custom]: custom,
};
