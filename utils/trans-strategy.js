import { tencentTransMap } from "../constants/constant.js";
import fetch from "node-fetch";
import _ from 'lodash'
import config from "../model/config.js";

// 定义翻译策略接口
export class TranslateStrategy {
    async translate(query, targetLanguage) {
        throw new Error("This method should be implemented by subclasses");
    }
}

// 企鹅翻译策略
export class TencentTranslateStrategy extends TranslateStrategy {
    constructor(config) {
        super();
        this.config = config;
        this.url = "https://transmart.qq.com/api/imt";
        this.commonHeaders = {
            "USER-AGENT": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/111.0"
        };
        this.clientKey = "browser-firefox-111.0.0-Mac OS-d35fca23-eb48-45ba-9913-114f1177b02b-1679376552800";
    }

    async detectLanguage(query) {
        try {
            const response = await fetch(this.url, {
                method: "POST",
                headers: this.commonHeaders,
                body: JSON.stringify({
                    "header": {
                        "fn": "text_analysis",
                        "client_key": this.clientKey
                    },
                    "text": query,
                    "type": "plain",
                    "normalize": {
                        "merge_broken_line": false
                    }
                })
            });
            const data = await response.json();
            return data.header.ret_code === 'succ' ? data.language : "en";
        } catch (error) {
            logger.error("Error detecting language:", error);
            return "en";
        }
    }

    async translate(query, targetLanguage) {
        try {
            const sourceLanguage = await this.detectLanguage(query);
            const response = await fetch(this.url, {
                method: "POST",
                headers: this.commonHeaders,
                body: JSON.stringify({
                    "header": {
                        "fn": "auto_translation",
                        "client_key": this.clientKey
                    },
                    "type": "plain",
                    "model_category": "normal",
                    "text_domain": "general",
                    "source": {
                        "lang": sourceLanguage,
                        "text_list": ["", query, ""]
                    },
                    "target": {
                        "lang": tencentTransMap[targetLanguage]
                    }
                })
            });
            const data = await response.json();
            return data.header.ret_code === 'succ' ? data.auto_translation?.[1] : "翻译失败";
        } catch (error) {
            logger.error("Error translating text:", error);
            return "翻译失败";
        }
    }
}

// Deepl翻译策略
export class DeeplTranslateStrategy extends TranslateStrategy {
    constructor(config) {
        super();
        this.config = config;
        this.deeplUrls = this.config.deeplApiUrls.includes(",") ? this.config.deeplApiUrls.split(",") : [this.config.deeplApiUrls];
    }

    async translate(query, targetLanguage) {
        const url = this.deeplUrls[Math.floor(Math.random() * this.deeplUrls.length)];
        logger.info(`[R插件][Deepl翻译]：当前使用的API：${url}`);
        try {
            const source_lang = await new TencentTranslateStrategy(this.config).detectLanguage(query);
            logger.info(`[R插件][Deepl翻译]：检测到的源语言：${source_lang}`);
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...this.commonHeaders
                },
                body: JSON.stringify({
                    text: query,
                    source_lang,
                    target_lang: tencentTransMap[targetLanguage]
                }),

            });
            const data = await response.json();
            return data.data;
        } catch (error) {
            logger.error("Error translating text:", error);
            return "翻译失败";
        }
    }
}

// GoogelAI/OpenAI 翻译策略
export class GeminiOpenAITranslateStrategy extends TranslateStrategy {
    constructor(config) {
        super();
        this.config = config;
        // GoogelAI 官方 URL
        this.geminiURL = "https://generativelanguage.googleapis.com";
    
        // 判断使用哪个API
        if (!_.isEmpty(this.config.xaiBaseURL) && !_.isEmpty(this.config.xaiApiKey)) {
            // 使用XAI API
            this.baseURL = this.config.xaiBaseURL;
            this.apiKey = this.config.xaiApiKey;
            this.currentModel = this.config.xaiModel;
        } else if (!_.isEmpty(this.config.aiBaseURL) && !_.isEmpty(this.config.aiApiKey)) {
            // 使用OpenAIAPI
            this.baseURL = this.config.aiBaseURL;
            this.apiKey = this.config.aiApiKey;
            this.currentModel = this.config.aiModel;
        } else {
            throw new Error("未配置 XAI 或 OpenAI API");
        }
    }    

    async translate(query, targetLanguage) {
        let aiContent;

        // 判断使用哪个API
        if (this.baseURL === this.geminiURL) {
            // 使用GoogelAI API
            const fullUrl = `${this.geminiURL}/v1beta/models/${this.currentModel}:generateContent`;
            logger.info(`[R插件][GoogelAI翻译]：完整的GoogelAI URL: ${fullUrl}`);
            logger.info(`[R插件][GoogelAI翻译]：使用的GoogelAI模型: ${this.currentModel}`);
            logger.info(`[R插件][GoogelAI翻译]：使用的GoogelAI密钥: ${this.apiKey.substring(0, 5)}...${this.apiKey.substring(this.apiKey.length - 5)}`);

            try {
                const response = await fetch(fullUrl, {
                    method: 'POST',
                    headers: {
                        "Content-Type": "application/json",
                        "x-goog-api-key": this.apiKey
                    },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{
                                text: `请将以下内容翻译成${targetLanguage}：${query},只需要给出译文`
                            }]
                        }],
                        generationConfig: {
                            temperature: 0.7,
                            topK: 40,
                            topP: 0.95,
                            maxOutputTokens: 8192,
                        },
                        safetySettings: []
                    })
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`GoogelAI API请求失败: ${response.status} ${errorText}`);
                }

                const responseData = await response.json();
                if (!responseData.candidates || !responseData.candidates[0] || !responseData.candidates[0].content) {
                    throw new Error('GoogelAI API返回数据格式错误');
                }

                aiContent = responseData.candidates[0].content.parts[0].text;
                logger.info(`[R插件][GoogelAI翻译]：请求成功`);
            } catch (error) {
                logger.error(`[R插件][GoogelAI翻译]：错误: ${error.message}`);
                return "翻译失败";
            }
        } else {
            // 使用OpenAI API
            logger.info(`[R插件][OpenAI翻译]：完整的OpenAI URL: ${this.baseURL}/v1/chat/completions`);
            logger.info(`[R插件][OpenAI翻译]：使用的OpenAI模型: ${this.currentModel}`);
            logger.info(`[R插件][OpenAI翻译]：使用的OpenAI密钥: ${this.apiKey.substring(0, 5)}...${this.apiKey.substring(this.apiKey.length - 5)}`);

            try {
                const completion = await fetch(this.baseURL + "/v1/chat/completions", {
                    method: 'POST',
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + this.apiKey
                    },
                    body: JSON.stringify({
                        model: this.currentModel,
                        messages: [
                            {
                                role: "user",
                                content: `请将以下内容翻译成${targetLanguage}：${query},只需要给出译文`
                            },
                        ]
                    })
                });

                if (!completion.ok) {
                    const errorText = await completion.text();
                    throw new Error(`OpenAI API请求失败: ${completion.status} ${errorText}`);
                }

                const responseData = await completion.json();
                if (!responseData?.choices?.[0]?.message?.content) {
                    throw new Error('OpenAI API返回数据格式错误');
                }

                aiContent = responseData.choices[0].message.content;
                logger.info(`[R插件][OpenAI翻译]：请求成功`);
            } catch (error) {
                logger.error(`[R插件][OpenAI翻译]：错误: ${error.message}`);
                return "翻译失败";
            }
        }

        return aiContent;
    }
}

export class Translate {
    constructor(config) {
        this.config = config;
        this.strategy = null;
    }

    selectStrategy() {
        // 首先检查 XAI 翻译（最高优先级）
        if (!_.isEmpty(this.config.xaiBaseURL) && !_.isEmpty(this.config.xaiApiKey)) {
            logger.info("[R插件][翻译策略]：当前选择 XAI 翻译");
            return new GeminiOpenAITranslateStrategy(this.config);
        }
    
        // 检查 Deepl 翻译（当 xaiBaseURL 和 xaiApiKey 都为空时）
        if (_.isEmpty(this.config.xaiBaseURL) && _.isEmpty(this.config.xaiApiKey)) {
            if (!_.isEmpty(this.config.deeplApiUrls)) {
                logger.info("[R插件][翻译策略]：当前选择 Deepl翻译");
                return new DeeplTranslateStrategy(this.config);
            }
        }
    
        // 只有在 xaiBaseURL 为空时，选择 OpenAI/Gemini 翻译
        if (_.isEmpty(this.config.xaiBaseURL)) {
            if (!_.isEmpty(this.config.aiBaseURL) && !_.isEmpty(this.config.aiApiKey)) {
                logger.info("[R插件][翻译策略]：当前选择 OpenAI/Gemini 翻译");
                return new GeminiOpenAITranslateStrategy(this.config);
            }
        }
    
        // 最后使用企鹅翻译
        logger.info("[R插件][翻译策略]：当前选择 企鹅翻译");
        return new TencentTranslateStrategy(this.config);
    }               

    async translate(query, targetLanguage) {
        if (!this.strategy) {
            this.strategy = this.selectStrategy();
        }
        return this.strategy.translate(query, targetLanguage);
    }
}
