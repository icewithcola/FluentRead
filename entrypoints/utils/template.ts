// 消息模板工具
import {customModelString, defaultOption} from "./option";
import {config} from "@/entrypoints/utils/config";

// openai 格式的消息模板（通用模板）
// pageSummary: optional page summary context to inject into the prompt for better translation
export function commonMsgTemplate(origin: string, pageSummary?: string) {
    // 检测是否使用自定义模型
    let model = config.model[config.service] === customModelString ? config.customModel[config.service] : config.model[config.service]

    // 删除模型名称中的中文括号及其内容，如"gpt-4（推荐）" -> "gpt-4"
    model = model.replace(/（.*）/g, "");

    let system = config.system_role[config.service] || defaultOption.system_role;
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', origin);

    // Inject page summary context into the system prompt if available
    if (pageSummary) {
        system += `\n\nPage context for reference (use this to improve translation accuracy, especially for proper nouns and domain-specific terms):\n${pageSummary}`;
    }

    const body: any = {
        'model': model,
        "temperature": 0.7,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ]
    };

    // Enable streaming if configured
    if (config.useStream) {
        body.stream = true;
    }

    return JSON.stringify(body);
}

/**
 * Build a summary request body for extracting key terms and background context from a page.
 * The summary result is NOT shown to users—it's injected into translation prompts to improve quality.
 * Always non-streaming since we need the full result before translations begin.
 */
export function summaryMsgTemplate(content: string) {
    let model = config.model[config.service] === customModelString ? config.customModel[config.service] : config.model[config.service]
    model = model.replace(/（.*）/g, "");

    const system = "You are a professional content analyst. Your job is to extract key context from webpage content to help a translator produce more accurate translations.";
    const user = `Analyze the following webpage content. Provide a brief context summary in 1-2 sentences, then list up to 10 key terms/proper nouns with their correct translations in ${config.to}. Format your response exactly as:\nContext: <brief background>\nKey terms: <term1> = <translation1>, <term2> = <translation2>, ...\n\n${content}`;

    const body: any = {
        'model': model,
        "temperature": 0.3,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ]
    };

    // Always non-streaming for summary since we need the full result upfront
    return JSON.stringify(body);
}
