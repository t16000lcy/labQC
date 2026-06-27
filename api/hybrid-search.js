const fs = require("fs");
const path = require("path");

const SAFETY_TEXT = "提醒：AI 回答僅供衛教參考，不能取代醫師診斷、治療、用藥調整或個人報告判讀。";
const REPORT_WARNING_TEXT = "警語：檢驗報告需由醫師依個人症狀、病史、用藥、影像與其他檢查綜合判讀。若出現胸痛、呼吸困難、意識改變、嚴重出血、高燒不退、黑便、血尿或檢驗科通知危急值，請立即就醫或依醫療人員指示處理。";
const CONTACT_TEXT = "目前知識庫未找到足夠明確的核准資料。請電洽 03-5580558 轉 1418 檢驗科諮詢電話，或 E-mail：055947@tool.caaumed.org.tw 檢驗科諮詢信箱。";
const MANUAL_CONTACT_TEXT = "人工諮詢方式：請電洽 03-5580558 轉 1418 檢驗科諮詢電話，或 E-mail：055947@tool.caaumed.org.tw 檢驗科諮詢信箱。";
const LAB_SEARCH_URL = "http://211.21.176.82:8098/#/";
const HOSPITAL_LAB_URL = "https://www.cmu-hch.cmu.edu.tw/Department/Detail?depid=28";
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const HIGH_CONFIDENCE = Number(process.env.QA_EMBED_HIGH_CONFIDENCE || 0.78);
const MEDIUM_CONFIDENCE = Number(process.env.QA_EMBED_MEDIUM_CONFIDENCE || 0.68);

function readJson(relativePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), relativePath), "utf8"));
  } catch {
    return fallback;
  }
}

const serviceHours = readJson("data/knowledge/service-hours.json", {});
const approvedQa = readJson("data/knowledge/approved-qa.json", []);
const labTests = readJson("data/knowledge/lab-tests.json", []);

let qaEmbeddingIndexPromise = null;

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, "")
    .replace(/[，、。；：？！?.,;:()[\]{}"'「」『』【】《》<>/\\|_-]/g, "");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function formatAnswer(answer) {
  return escapeHtml(answer).replace(/\n/g, "<br>");
}

function containsAny(message, terms) {
  const raw = String(message || "");
  const normalized = normalize(raw);
  return terms.some((term) => normalized.includes(normalize(term)) || raw.includes(term));
}

function qaById(id) {
  return approvedQa.find((item) => item.id === id);
}

function qaDocument(item) {
  return [
    item.id,
    item.category,
    item.question,
    item.keywords || "",
    item.answer
  ].filter(Boolean).join("\n");
}

function qaSource(item) {
  return item.source || `核准題庫；${item.id}`;
}

function qaSingleReply(item, sourcePrefix = "") {
  return {
    content: `<strong>${escapeHtml(item.question)}</strong><br>${formatAnswer(item.answer)}<br><br>${SAFETY_TEXT}`,
    source: `${sourcePrefix}${qaSource(item)}`
  };
}

function qaChoiceReply(items, source = "核准題庫；相似問題候選") {
  const choices = items.slice(0, 5).map((item) =>
    `<label class="qa-choice"><input type="checkbox" value="${escapeHtml(item.id)}"><span><strong>${escapeHtml(item.question)}</strong><small>${escapeHtml(qaSource(item))}</small></span></label>`
  ).join("");
  return {
    content: `我找到幾個相近的核准題庫答案，請勾選最符合的問題：<div class="qa-choice-list">${choices}</div><button class="qa-choice-submit" type="button">顯示勾選答案</button><small class="choice-hint">可複選；若都不是，請換一個更完整的關鍵字再問一次。</small>`,
    source
  };
}

function contactReply() {
  return {
    content: `${CONTACT_TEXT}<br><br>${SAFETY_TEXT}`,
    source: "檢驗科諮詢窗口"
  };
}

function fixedRuleReply(message) {
  const text = String(message || "");
  const normalized = normalize(text);

  if (/(人工|真人|電話|信箱|email|e-mail|聯絡|諮詢窗口|轉人工)/i.test(text)) {
    return {
      content: `${MANUAL_CONTACT_TEXT}<br><br>${SAFETY_TEXT}`,
      source: "檢驗科諮詢窗口"
    };
  }

  if (/(國定假日|中秋|教師節|國慶|光復|行憲|115年).*(抽血|服務|時間|櫃台|櫃檯)/.test(text)) {
    return {
      content: `${formatAnswer(serviceHours.holiday_answer || "")}<br><br><a href="${HOSPITAL_LAB_URL}" target="_blank" rel="noopener">開啟院方檢驗科頁面</a><br><br>${SAFETY_TEXT}`,
      source: serviceHours.holiday_source || "抽血櫃檯服務時間"
    };
  }

  if (/(抽血|檢驗科|櫃台|櫃檯).*(時間|幾點|服務|開到|營業)|(時間|幾點).*(抽血|櫃台|櫃檯)/.test(text)) {
    const answer = serviceHours.answer || "抽血櫃檯服務時間：\n星期一至五：上午7:30～晚上21:30止。\n星期六：上午7:30～中午12:00止。\n實驗室服務時間：24小時全年無休。";
    const labAnswer = answer.includes("實驗室服務時間") ? answer : `${answer}\n實驗室服務時間：24小時全年無休。`;
    return {
      content: `${formatAnswer(labAnswer)}<br><br><a href="${HOSPITAL_LAB_URL}" target="_blank" rel="noopener">開啟院方檢驗科頁面</a><br><br>${SAFETY_TEXT}`,
      source: `${serviceHours.source || "院方檢驗科頁面"}；SERVICE_BLOOD_DRAW_HOURS`
    };
  }

  const directQaRules = [
    {
      ids: ["PF33"],
      pattern: /中國醫點通|點通|(app|APP|手機|線上).*(報告|檢驗|看不到|查不到|院所|新竹附設醫院)|(報告|檢驗|看不到|查不到|院所).*(中國醫點通|點通|app|APP|手機|線上)|新竹附設醫院|院所要選|選哪個院所|選錯院所/
    },
    {
      ids: ["PF34"],
      pattern: /(女性|女生|婦女|病人)?.*(mc|MC|月經|生理期|經期).*(驗尿|尿液|尿檢|尿液檢查|檢驗單|隔多久|何時|什麼時候)|(驗尿|尿液|尿檢|尿液檢查).*(mc|MC|月經|生理期|經期|隔多久|何時|什麼時候)|(mc|MC|月經|生理期|經期).*乾淨.*(2|3|二|三).*天/
    },
    {
      ids: ["MQ078"],
      pattern: /(抽血單|檢驗單).*(遺失|不見|弄丟)|(遺失|不見|弄丟).*(抽血單|檢驗單)|抽血單|檢驗單遺失/
    },
    {
      ids: ["MQ015"],
      pattern: /(糖尿病|血糖|降血糖).*(藥|用藥|吃藥|服藥|抽血|空腹)|(藥|用藥|吃藥|服藥).*(糖尿病|血糖|降血糖)/
    },
    {
      ids: ["MQ016"],
      pattern: /(高血壓|血壓|降血壓).*(藥|用藥|吃藥|服藥|抽血|空腹)|(藥|用藥|吃藥|服藥).*(高血壓|血壓|降血壓)/
    },
    {
      ids: ["PF3"],
      pattern: /(空腹|禁食).*(喝水|白開水|水)|(喝水|白開水|水).*(空腹|禁食)/
    },
    {
      ids: ["PF2"],
      pattern: /(抽血|檢查|檢驗).*(一定要|需要|要不要|是否).*(空腹|禁食)|(空腹|禁食).*(抽血|檢查|檢驗)/
    },
    {
      ids: ["PF6"],
      pattern: /瘀青|淤青|血腫|黑青|抽血.*腫|抽血.*青/
    }
  ];

  const matched = directQaRules.find((rule) => rule.pattern.test(text) || rule.pattern.test(normalized));
  if (matched) {
    const items = matched.ids.map(qaById).filter(Boolean);
    if (items.length === 1) return qaSingleReply(items[0], "固定規則優先；");
    if (items.length > 1) return qaChoiceReply(items, "固定規則優先；相近核准題庫");
  }

  return null;
}

const SYSTEM_EXPANSIONS = {
  肝功能: ["肝功能", "肝指數", "肝臟", "AST", "ALT", "GOT", "GPT", "Bilirubin", "膽紅素", "ALP", "GGT", "Albumin", "白蛋白", "Total protein", "PT", "INR"],
  腎功能: ["腎功能", "腎臟", "腎病", "腎衰竭", "尿毒", "GFR", "eGFR", "Creatinine", "肌酸酐", "BUN", "尿素氮", "Cystatin C", "尿蛋白", "白蛋白尿", "微量白蛋白", "ACR", "尿液檢查", "24小時尿", "電解質", "鉀", "磷", "鈣"],
  糖尿病: ["糖尿病", "血糖", "HbA1c", "A1C", "醣化血紅素", "空腹血糖", "飯前血糖", "飯後血糖", "Glucose", "Insulin", "C-peptide"],
  貧血: ["貧血", "血紅素", "血色素", "CBC", "紅血球", "MCV", "MCH", "MCHC", "Ferritin", "鐵蛋白", "鐵", "B12", "葉酸", "地中海型貧血"]
};

const TOPIC_PREFERRED_TERMS = {
  肝功能: ["ALT", "AST", "GOT", "GPT", "ALP", "GGT", "Bilirubin", "膽紅素", "Albumin", "白蛋白", "Total protein", "PT", "INR"],
  腎功能: ["Creatinine", "肌酸酐", "eGFR", "GFR", "BUN", "尿素氮", "Cystatin C", "尿蛋白", "白蛋白尿", "ACR", "尿液檢查", "24小時尿", "鉀", "磷", "鈣"],
  糖尿病: ["HbA1c", "A1C", "醣化血紅素", "Glucose", "血糖", "空腹血糖", "飯前血糖", "飯後血糖", "Insulin", "C-peptide"],
  貧血: ["CBC", "血液常規", "血紅素", "血色素", "MCV", "MCH", "Ferritin", "鐵蛋白", "鐵", "B12", "葉酸"]
};

const QUERY_STOP_TERMS = new Set([
  "是什麼",
  "什麼",
  "請問",
  "可以",
  "需要",
  "怎麼辦",
  "代表什麼",
  "嚴重嗎",
  "檢驗",
  "檢查",
  "項目",
  "意義",
  "用途",
  "紅字",
  "偏高",
  "偏低"
].map(normalize));

const TEST_LIST_REPLIES = {
  肝功能: "「肝功能檢驗」不是單一檢驗，而是一組與肝細胞傷害、膽汁鬱積、膽紅素代謝、肝臟合成功能相關的檢驗。常見可包含 ALT、AST、ALP、GGT、bilirubin、albumin、total protein、PT/INR 等。詳細請到檢驗項目查詢系統進行搜尋。",
  腎功能: "「腎功能檢驗」不是單一檢驗，而是一組用來了解腎臟過濾、代謝廢物排除、尿蛋白與電解質狀態的檢驗。常見可包含 Creatinine、eGFR、BUN、Cystatin C、尿蛋白、白蛋白尿/ACR、尿液檢查、24小時尿與電解質等。詳細請到檢驗項目查詢系統進行搜尋。",
  糖尿病: "「糖尿病相關檢驗」常見包含空腹血糖、飯前/飯後血糖、HbA1c、尿糖、尿蛋白或腎功能相關項目。不同檢驗反映的時間範圍不同，是否需要空腹請依醫囑與檢驗單為準。",
  貧血: "「貧血相關檢驗」常見包含 CBC、血紅素 Hb、紅血球、MCV、MCH、鐵蛋白 ferritin、鐵、維生素 B12、葉酸等。這些檢驗可協助醫師了解貧血線索，但不能單靠單一數值診斷原因。"
};

function detectSystemTopic(message) {
  const normalized = normalize(message);
  const directTopic = Object.keys(SYSTEM_EXPANSIONS).find((topic) => normalized.includes(normalize(topic)));
  if (directTopic) return directTopic;

  const broadListIntent = /(功能|相關).*(檢驗|檢查|項目|有哪些|要驗)|(檢驗|檢查|項目).*(有哪些|要驗)|(有哪些|要驗什麼)/.test(String(message || ""));
  if (!broadListIntent) return "";

  return Object.entries(SYSTEM_EXPANSIONS).find(([, terms]) =>
    terms.some((term) => normalized.includes(normalize(term)))
  )?.[0] || "";
}

function isReportConcern(message) {
  return /(紅字|異常|偏高|偏低|嚴重|危險|有病|怎麼辦|代表什麼)/.test(String(message || ""));
}

function labIntent(message, mode) {
  const text = String(message || "");
  return mode === "test" ||
    /(檢驗|檢查|項目|意義|用途|參考值|紅字|功能|指數|有哪些|要驗什麼)/.test(text) ||
    /\b(ALT|AST|GOT|GPT|HbA1c|A1C|CBC|BUN|eGFR|Creatinine|CRP|TSH|LDL|HDL|TG)\b/i.test(text) ||
    /(肝功能|腎功能|糖尿病|血糖|貧血|血脂|甲狀腺)/.test(text);
}

function tokenize(value) {
  const raw = String(value || "");
  const ascii = raw.match(/[A-Za-z][A-Za-z0-9.+/-]{1,}/g) || [];
  const cjk = raw
    .replace(/[A-Za-z0-9.+/-]+/g, " ")
    .split(/[，、。；：？！\s,.;:?!()[\]{}"'「」『』/\\|_-]+/)
    .filter((term) => term.length >= 2);
  return [...new Set([...ascii, ...cjk].map(normalize).filter((term) => term && !QUERY_STOP_TERMS.has(term)))];
}

function fieldText(test) {
  return [
    test.code,
    test.name,
    test.english,
    test.abbreviation,
    test.category,
    test.related_system,
    test.clinical_use,
    test.meaning,
    test.keywords,
    test.note,
    test.notice,
    ...(Array.isArray(test.aliases) ? test.aliases : [])
  ].filter(Boolean).join(" ");
}

function preferredTopicBoost(test, topic) {
  const preferred = TOPIC_PREFERRED_TERMS[topic] || [];
  const haystack = normalize(fieldText(test));
  const exactFields = [
    test.code,
    test.name,
    test.english,
    test.abbreviation,
    ...(Array.isArray(test.aliases) ? test.aliases : [])
  ].filter(Boolean).map(normalize);

  for (let index = 0; index < preferred.length; index += 1) {
    const term = normalize(preferred[index]);
    if (!term) continue;
    if (exactFields.some((field) => field === term || field.startsWith(term)) || haystack.includes(term)) {
      return 10000 - index * 100;
    }
  }
  return 0;
}

function exactFieldScore(test, queryTerms) {
  const exactFields = [
    test.code,
    test.name,
    test.english,
    test.abbreviation,
    ...(Array.isArray(test.aliases) ? test.aliases : [])
  ].filter(Boolean);
  let score = 0;
  for (const field of exactFields) {
    const normalizedField = normalize(field);
    for (const term of queryTerms) {
      if (!term) continue;
      if (normalizedField === term) score += 120;
      else if (normalizedField.startsWith(term) && term.length >= 3) score += 55;
      else if (term.length >= 4 && normalizedField.includes(term)) score += 18;
    }
  }
  return score;
}

function hasPrimaryExactField(test, queryTerms) {
  const primaryFields = [
    test.code,
    test.name,
    test.english,
    test.abbreviation
  ].filter(Boolean).map(normalize);
  return queryTerms.some((term) =>
    primaryFields.some((field) => field === term || field.startsWith(term) || (term.length >= 3 && field.includes(term)))
  );
}

function labTestScore(test, message, expansionTerms = []) {
  const queryTerms = [...new Set([...tokenize(message), ...expansionTerms.map(normalize)])];
  const haystack = normalize(fieldText(test));
  let score = exactFieldScore(test, queryTerms);

  for (const term of queryTerms) {
    if (term.length < 2) continue;
    if (haystack.includes(term)) score += term.length >= 4 ? 8 : 3;
  }

  return score;
}

function findLabTests(message) {
  const topic = detectSystemTopic(message);
  const expansionTerms = topic ? SYSTEM_EXPANSIONS[topic] : [];
  const queryTerms = tokenize(message);
  const hasShortExactAcronym = queryTerms.some((term) => /^[a-z0-9.+/-]{2,6}$/.test(term));
  const scored = labTests
    .map((item) => ({ item, score: labTestScore(item, message, expansionTerms) + preferredTopicBoost(item, topic) }))
    .filter((entry) => !hasShortExactAcronym || topic || hasPrimaryExactField(entry.item, queryTerms))
    .filter((entry) => entry.score >= (hasShortExactAcronym && !topic ? 80 : 20))
    .sort((a, b) => b.score - a.score)
    .slice(0, topic ? 8 : 5);

  return { topic, tests: scored.map((entry) => entry.item) };
}

function labTestReply(topic, tests, reportConcern = false) {
  const warning = reportConcern ? `<br><br>${REPORT_WARNING_TEXT}` : "";
  if (topic && TEST_LIST_REPLIES[topic]) {
    const rows = tests.slice(0, 6).map((item) => (
      `<tr><td>${escapeHtml(item.name || item.code || "")}</td><td>${escapeHtml(item.clinical_use || item.meaning || "請參考檢驗項目查詢系統")}</td><td>${escapeHtml(item.specimen || "依檢驗項目查詢系統")}</td><td>${escapeHtml(item.fasting || "依醫囑或檢驗單")}</td><td>${escapeHtml(item.notice || item.note || "依檢驗項目查詢系統與醫囑")}</td></tr>`
    )).join("");
    const table = rows ? `<table class="answer-table"><thead><tr><th>檢驗項目</th><th>用途</th><th>檢體類型</th><th>是否需空腹</th><th>注意事項</th></tr></thead><tbody>${rows}</tbody></table>` : "";
    return {
      content: `${escapeHtml(TEST_LIST_REPLIES[topic])}<br><br>${table}<br><a href="${LAB_SEARCH_URL}" target="_blank" rel="noopener">開啟檢驗項目查詢系統</a><br><br>以上為衛教參考，實際檢驗項目與是否需醫囑，請依醫師開立與本院檢驗科規範為準。${warning}<br><br>${SAFETY_TEXT}`,
      source: `檢驗項目資料庫優先；${topic}；檢驗項目查詢系統`
    };
  }

  if (tests.length) {
    const body = tests.slice(0, 3).map((item) => [
      `<strong>${escapeHtml(item.name || item.code)}${item.english ? ` / ${escapeHtml(item.english)}` : ""}</strong>`,
      item.clinical_use || item.meaning ? `檢驗意義：${escapeHtml(item.clinical_use || item.meaning)}` : "",
      item.specimen ? `檢體類型：${escapeHtml(item.specimen)}` : "",
      item.fasting ? `是否需空腹：${escapeHtml(item.fasting)}` : "",
      item.notice || item.note ? `注意事項：${escapeHtml(item.notice || item.note)}` : ""
    ].filter(Boolean).join("<br>")).join("<br><br>");
    return {
      content: `${body}<br><br><a href="${LAB_SEARCH_URL}" target="_blank" rel="noopener">開啟檢驗項目查詢系統</a>${warning}<br><br>${SAFETY_TEXT}`,
      source: `檢驗項目資料庫優先；${tests.map((item) => item.code || item.name).join("、")}`
    };
  }

  return null;
}

function qaTerms(value) {
  return tokenize(value);
}

const QA_SEMANTIC_GROUPS = [
  ["抽血單", "檢驗單", "抽血單子", "檢驗單子", "單子"],
  ["遺失", "不見", "弄丟", "忘記帶", "沒帶"],
  ["中國醫點通", "點通", "APP", "app", "手機查報告", "線上報告", "報告查不到", "看不到報告", "新竹附設醫院", "院所選擇"],
  ["MC", "mc", "月經", "生理期", "經期", "驗尿", "尿液檢查", "尿液", "尿檢", "隔多久", "乾淨後", "清潔中段尿"],
  ["空腹", "禁食", "不能吃", "沒吃東西"],
  ["瘀青", "淤青", "血腫", "黑青"],
  ["ctDNA", "NGS", "液態切片", "液體切片", "次世代定序"]
];

function expandedQaTerms(message) {
  const base = qaTerms(message);
  const expanded = new Set(base);
  const normalizedMessage = normalize(message);
  for (const group of QA_SEMANTIC_GROUPS) {
    if (group.some((term) => normalizedMessage.includes(normalize(term)))) {
      group.forEach((term) => expanded.add(normalize(term)));
    }
  }
  return [...expanded];
}

function lexicalQaScore(item, message) {
  const normalizedMessage = normalize(message);
  const terms = expandedQaTerms(message);
  const question = normalize(item.question);
  const keywords = normalize(item.keywords || "");
  const answer = normalize(item.answer);
  const haystack = `${question} ${keywords} ${answer} ${normalize(item.category || "")} ${normalize(item.id)}`;
  let score = 0;

  if (normalizedMessage && question.includes(normalizedMessage)) score += 80;
  if (normalizedMessage && haystack.includes(normalizedMessage)) score += 45;
  if (normalizedMessage.includes(normalize(item.id))) score += 100;

  for (const term of terms) {
    if (term.length < 2) continue;
    const weight = term.length >= 4 ? 14 : 7;
    if (question.includes(term)) score += weight + 10;
    if (keywords.includes(term)) score += weight + 18;
    if (answer.includes(term)) score += Math.max(3, Math.floor(weight / 2));
  }
  return score;
}

function lexicalQaCandidates(message, limit = 12) {
  return approvedQa
    .map((item) => ({ item, lexicalScore: lexicalQaScore(item, message), vectorScore: null }))
    .filter((entry) => entry.lexicalScore >= 18)
    .sort((a, b) => b.lexicalScore - a.lexicalScore)
    .slice(0, limit);
}

async function embedTexts(texts) {
  if (!process.env.OPENAI_API_KEY) return null;
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts })
  });
  if (!response.ok) return null;
  const payload = await response.json();
  return payload.data?.map((entry) => entry.embedding) || null;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

async function buildQaEmbeddingIndex() {
  const batchSize = Number(process.env.QA_EMBED_BATCH_SIZE || 96);
  const rows = [];
  for (let i = 0; i < approvedQa.length; i += batchSize) {
    const batch = approvedQa.slice(i, i + batchSize);
    const embeddings = await embedTexts(batch.map(qaDocument));
    if (!embeddings || embeddings.length !== batch.length) return null;
    batch.forEach((item, index) => rows.push({ item, embedding: embeddings[index] }));
  }
  return rows;
}

async function getQaEmbeddingIndex() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (process.env.QA_EMBED_FULL_INDEX !== "true") return null;
  if (!qaEmbeddingIndexPromise) qaEmbeddingIndexPromise = buildQaEmbeddingIndex().catch(() => null);
  return qaEmbeddingIndexPromise;
}

async function vectorQaCandidates(message, lexicalCandidates) {
  const queryEmbedding = (await embedTexts([String(message || "")]))?.[0];
  if (!queryEmbedding) return lexicalCandidates;

  const index = await getQaEmbeddingIndex();
  if (!index) {
    if (!lexicalCandidates.length) return lexicalCandidates;
    const candidateEmbeddings = await embedTexts(lexicalCandidates.map(({ item }) => qaDocument(item)));
    if (!candidateEmbeddings || candidateEmbeddings.length !== lexicalCandidates.length) return lexicalCandidates;
    return lexicalCandidates
      .map((entry, index) => ({
        item: entry.item,
        vectorScore: cosineSimilarity(queryEmbedding, candidateEmbeddings[index]),
        lexicalScore: entry.lexicalScore
      }))
      .sort((a, b) => (b.vectorScore * 100 + b.lexicalScore * 0.12) - (a.vectorScore * 100 + a.lexicalScore * 0.12))
      .slice(0, 8);
  }

  const lexicalMap = new Map(lexicalCandidates.map((entry) => [entry.item.id, entry.lexicalScore]));
  const vectorTop = index
    .map(({ item, embedding }) => ({
      item,
      vectorScore: cosineSimilarity(queryEmbedding, embedding),
      lexicalScore: lexicalMap.get(item.id) || lexicalQaScore(item, message)
    }))
    .sort((a, b) => (b.vectorScore * 100 + b.lexicalScore * 0.12) - (a.vectorScore * 100 + a.lexicalScore * 0.12))
    .slice(0, 8);

  return vectorTop;
}

async function findQaHybrid(message) {
  const lexical = lexicalQaCandidates(message, 12);
  const vector = await vectorQaCandidates(message, lexical);
  const candidates = vector.length ? vector : lexical;
  if (!candidates.length) return { type: "none", items: [] };

  const [top, second] = candidates;
  const vectorScore = top.vectorScore ?? 0;
  const lexicalScore = top.lexicalScore ?? 0;
  const secondScore = second ? (second.vectorScore ?? 0) : 0;

  if ((top.vectorScore != null && vectorScore >= HIGH_CONFIDENCE && vectorScore - secondScore >= 0.035) || lexicalScore >= 85) {
    return { type: "direct", items: [top.item], scores: { vectorScore, lexicalScore } };
  }

  if ((top.vectorScore != null && vectorScore >= MEDIUM_CONFIDENCE) || lexicalScore >= 35) {
    return { type: "choices", items: candidates.slice(0, 5).map((entry) => entry.item), scores: { vectorScore, lexicalScore } };
  }

  return { type: "none", items: [] };
}

async function answerFromHybrid(message, mode = "education") {
  const fixed = fixedRuleReply(message);
  if (fixed) return fixed;

  const lab = findLabTests(message);
  const reportConcern = isReportConcern(message);
  if (labIntent(message, mode)) {
    const reply = labTestReply(lab.topic, lab.tests, reportConcern);
    if (reply) return reply;
    if (mode === "test") {
      return {
        content: `檢驗項目查詢請到 <a href="${LAB_SEARCH_URL}" target="_blank" rel="noopener">${LAB_SEARCH_URL}</a> 進行查詢。<br><br>${SAFETY_TEXT}`,
        source: "檢驗項目查詢系統"
      };
    }
  }

  const qa = await findQaHybrid(message);
  if (qa.type === "direct") return qaSingleReply(qa.items[0], qa.scores?.vectorScore ? "embeddings 相似度檢索；" : "題庫優先檢索；");
  if (qa.type === "choices") return qaChoiceReply(qa.items, qa.scores?.vectorScore ? "embeddings 相似度檢索；中等信心候選" : "題庫模糊檢索；中等信心候選");

  if (!labIntent(message, mode) && lab.tests.length) {
    const reply = labTestReply(lab.topic, lab.tests, reportConcern);
    if (reply) return reply;
  }

  return contactReply();
}

module.exports = {
  answerFromHybrid,
  _private: {
    normalize,
    fixedRuleReply,
    findLabTests,
    lexicalQaCandidates,
    findQaHybrid
  }
};
