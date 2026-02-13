import {commonMsgTemplate} from "../utils/template";
import {method} from "../utils/constant";
import {services} from "@/entrypoints/utils/option";
import {config} from "@/entrypoints/utils/config";
import {contentPostHandler} from "@/entrypoints/utils/check";

async function custom(message: any) {

    let headers = new Headers();
    headers.append('Content-Type', 'application/json');
    headers.append('Authorization', `Bearer ${config.token[services.custom]}`);

    const resp = await fetch(config.custom, {
        method: method.POST,
        headers: headers,
        body: commonMsgTemplate(message.origin)
    });

    if (!resp.ok) {
        console.log("翻译失败：", resp);
        throw new Error(`翻译失败: ${resp.status} ${resp.statusText} body: ${await resp.text()}`);
    }

    // Streaming mode: parse SSE chunks and send via port
    if (config.useStream && message._port) {
        return await parseStreamResponse(resp, message._port);
    }

    // Non-streaming mode: parse JSON response
    let result = await resp.json();
    return contentPostHandler(result.choices[0].message.content);
}

/**
 * Parse an SSE (Server-Sent Events) streaming response from an OpenAI-compatible API.
 * Sends each content delta to the content script via Port for real-time DOM updates.
 * Returns the full accumulated translated text.
 */
async function parseStreamResponse(resp: Response, port: any): Promise<string> {
    const reader = resp.body?.getReader();
    if (!reader) {
        throw new Error("翻译失败: 无法获取响应流");
    }

    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let result = "";

    while (true) {
        const {done, value} = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, {stream: true});

        // Process complete SSE lines
        const lines = buffer.split("\n");
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue;
            if (trimmed === "data: [DONE]") continue;

            if (trimmed.startsWith("data: ")) {
                const jsonStr = trimmed.slice(6);
                try {
                    const chunk = JSON.parse(jsonStr);
                    const delta = chunk.choices?.[0]?.delta?.content;
                    if (delta) {
                        result += delta;
                        // Send each chunk to content script in real-time
                        try {
                            port.postMessage({type: 'stream-chunk', chunk: delta, accumulated: result});
                        } catch (e) {
                            // Port may have been disconnected
                            console.warn("Port disconnected, stopping stream");
                            reader.cancel();
                            return contentPostHandler(result);
                        }
                    }
                } catch (e) {
                    console.warn("Stream chunk parse error:", e, jsonStr);
                }
            }
        }
    }

    if (!result) {
        throw new Error("翻译失败: 流式响应未返回有效内容");
    }

    return contentPostHandler(result);
}

export default custom;