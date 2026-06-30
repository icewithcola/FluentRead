// 防抖限流函数，可传递参数
import {franc} from "franc-min";

// 防抖限流函数，可传递参数
export function throttle(fn: (...args: any[]) => void, interval: number) {
    let last = 0; // 维护上次执行的时间
    return function (this: any, ...args: any[]) {
        const now = Date.now();
        // 只有当前时间与上次执行时间差大于等于间隔时才执行
        if (now - last >= interval) {
            last = now;
            fn.apply(this, args);  // 使用 apply 来传递参数数组
        }
    };
}

// 判断是否为粤语
export function isCantonese(text: string): boolean {
    // 1. 至少要包含2个字符才进行判定，避免单字误判
    if (text.length < 2) {
        return false;
    }

    // 2. 检查是否含有非常独特的粤语专属字
    const uniqueRegex = /[啲哋嚟咁喺咗搵嘢啱冇嗰攞㗎啫瞓諗谂氹嘥慳孭唞係咩]/;
    if (uniqueRegex.test(text)) {
        return true;
    }

    // 3. 检查是否含有非常独特的粤语词汇
    const cantoneseWords = [
        '边度', '邊度', '边个', '邊個', '点解', '點解', 
        '几时', '幾時', '系咪', '係咪', '呢排', '几多', 
        '幾多', '唔好', '对唔住', '對唔住', '唔知', 
        '唔系', '唔係', '埋单', '埋單'
    ];
    if (cantoneseWords.some(word => text.includes(word))) {
        return true;
    }

    // 4. 检查是否含有多个粤语常用字（如至少2个）以避免单字在普通话中的误判
    const ambiguousRegex = /[唔睇佢乜咪畀嬲靓叻温晒]/g;
    const matches = text.match(ambiguousRegex);
    if (matches && matches.length >= 2) {
        return true;
    }

    return false;
}

// 输出标准的语言类型，franc 只返回最可信的结果，francAll 返回所有结果并包含确信度
export function detectlang(origin: string): string {
    // 优先检测是否为粤语
    if (isCantonese(origin)) {
        return "yue";
    }

    const find = franc(origin, {minLength: 0});
    // 返回对应的标准语言代码
    switch (find) {
        case "cmn":
            return "zh-Hans";
        case "eng":
            return "en";
        case "jpn":
            return "ja";
        case "kor":
            return "ko";
        case "fra":
            return "fr";
        case "rus":
            return "ru";
        default:
            return find; // 返回其他语言的识别结果
    }
}

// 获取触摸点的中心位置
export function getCenterPoint(touches: TouchList, point: number): { x: number, y: number } | undefined {
    // 检查触摸点数量是否等于指定的数量
    if (touches.length !== point) return;

    let centerX = 0;
    let centerY = 0;
    // 累加所有触摸点的坐标
    for (let i = 0; i < touches.length; i++) {
        centerX += touches[i].clientX;
        centerY += touches[i].clientY;
    }
    // 计算中心点坐标
    centerX /= touches.length;
    centerY /= touches.length;

    return {x: centerX, y: centerY};
}

// 按 selector 查找匹配的元素，返回匹配的元素或 false
export function findMatchingElement(element: Element, selector: string): Element | false {
    // 检查当前元素是否匹配传入的选择器
    if (element.matches(selector)) return element;

    // 遍历父元素，直到找到匹配的元素或没有父元素
    let parent = element.parentElement;
    while (parent) {
        if (parent.matches(selector)) return parent;
        parent = parent.parentElement;
    }

    return false; // 未找到匹配元素
}