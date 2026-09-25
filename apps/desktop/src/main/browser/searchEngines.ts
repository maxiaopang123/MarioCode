/**
 * Search-engine host rules, shared by the browser tools' guard (the agent's
 * browser may not be used as a search engine) and the built-in web tools
 * (web_fetch refuses results pages, web_search drops links back into one).
 *
 * Host rules are deliberately narrow: only the engine's own search hosts
 * (root / www / regional search subdomains). Product subdomains such as
 * docs.google.com, pan.baidu.com, developer.baidu.com stay reachable.
 */
const SEARCH_ENGINE_HOST_RULES: ReadonlyArray<{ label: string; test: RegExp }> = [
  { label: "Google", test: /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/ },
  { label: "Bing", test: /^((www|cn|m|global)\.)?bing\.com$/ },
  { label: "百度", test: /^((www|m|wap)\.)?baidu\.com$/ },
  { label: "DuckDuckGo", test: /(^|\.)duckduckgo\.com$/ },
  { label: "搜狗", test: /^((www|m|wap)\.)?sogou\.com$/ },
  { label: "360 搜索", test: /^((www|m)\.)?so\.com$/ },
  { label: "神马搜索", test: /^((www|m|quark)\.)?sm\.cn$/ },
  { label: "头条搜索", test: /^so\.toutiao\.com$/ },
  { label: "Yandex", test: /^(www\.)?(yandex\.(com|ru|com\.tr)|ya\.ru)$/ },
  { label: "Yahoo 搜索", test: /(^|\.)search\.yahoo\.(com|co\.jp)$/ },
  { label: "Brave Search", test: /^search\.brave\.com$/ },
  { label: "Startpage", test: /^(www\.)?startpage\.com$/ },
  { label: "Ecosia", test: /^(www\.)?ecosia\.org$/ },
  { label: "Kagi", test: /^(www\.)?kagi\.com$/ },
  { label: "You.com", test: /^(www\.)?you\.com$/ },
  { label: "Perplexity", test: /^(www\.)?perplexity\.ai$/ },
];

/** Return the engine label when `url` points at a search engine's search host,
 *  else null. Only http(s) URLs are inspected; unparsable input → null (the
 *  caller's own validation reports it). */
export function matchSearchEngine(url: string): string | null {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const rule of SEARCH_ENGINE_HOST_RULES) {
    if (rule.test.test(host)) return rule.label;
  }
  return null;
}
