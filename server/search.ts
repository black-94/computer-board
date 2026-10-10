/**
 * 机器搜索的 BM25 相关性排序：只使用 id、name、host 三个字段，纯内存计算，不触发探活。
 *
 * 约定：
 * - k1 = 1.2、b = 0.75（BM25 常用默认值）。
 * - IDF 采用恒正形式 ln(1 + (N - df + 0.5) / (df + 0.5))，避免常见词（df > N/2）出现负分，
 *   保证命中项的分数始终为正、有限。
 * - 分词：先小写归一化，再按「连续字母数字」与「单个 CJK 汉字」切分；所有非字母数字、非汉字的字符
 *   （空白、`-`、`_`、`.`、`:`、`/`、`@` 等常见 id/host 分隔符）都视作边界。于是
 *   `remote-comfyui` → `remote`、`comfyui`，`root@192.168.0.1:22` → `root`、`192`、`168`、`0`、`1`、`22`，
 *   中文名 `本机` → `本`、`机`（CJK 无空格，按单字成词）。
 */

/** 参与搜索的机器字段；desc、instruction、software 等一律不进入索引。 */
export type SearchDocument = { id: string; name: string; host: string };

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

const tokenPattern = /[a-z0-9]+|[\u4e00-\u9fff]/g;

/** 小写归一化并分词；没有可切分的字符时返回空数组。 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(tokenPattern) ?? [];
}

export type SearchHit<T> = { document: T; score: number };

/**
 * 按 BM25 对文档排序并降序返回，分数相同者保持输入顺序（稳定）。
 *
 * score(q, D) = Σ_{t∈q, tf>0} IDF(t) · tf(t,D)·(k1+1) / (tf(t,D) + k1·(1 - b + b·|D|/avgdl))
 * IDF(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
 *
 * query 中的重复词去重，避免同一关键词被重复累加；tf 为 0 的词不贡献分数。
 */
export function rank<T>(query: string, documents: T[], toDocument: (item: T) => SearchDocument): SearchHit<T>[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !documents.length) return [];
  const tokenLists = documents.map(item => tokenize(documentText(toDocument(item))));
  const lengths = tokenLists.map(tokens => tokens.length);
  const documentCount = documents.length;
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documentCount;
  const frequencies = tokenLists.map(tokens => {
    const map = new Map<string, number>();
    for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
    return map;
  });
  // 先按 query 词预计算 df/IDF，避免对每个「命中文档 × 关键词」重复扫描整个语料。
  const idfByTerm = new Map<string, number>();
  for (const term of terms) {
    const df = frequencies.reduce((count, map) => count + (map.has(term) ? 1 : 0), 0);
    idfByTerm.set(term, Math.log(1 + (documentCount - df + 0.5) / (df + 0.5)));
  }
  const hits: { index: number; document: T; score: number }[] = [];
  documents.forEach((document, index) => {
    let score = 0;
    for (const term of terms) {
      const tf = frequencies[index].get(term);
      if (!tf) continue;
      const idf = idfByTerm.get(term) ?? 0;
      score += (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (lengths[index] / (averageLength || 1))));
    }
    if (score > 0) hits.push({ index, document, score });
  });
  return hits.sort((a, b) => b.score - a.score || a.index - b.index).map(({ document, score }) => ({ document, score }));
}

const documentText = (document: SearchDocument) => `${document.id} ${document.name} ${document.host}`;

/**
 * 可复用的 BM25 索引：构建时一次性算好每台机器的词频（TF）、文档长度与倒排表，之后查询只对关键词分词，
 * 直接复用这些缓存按候选下标集合计算 N/df/avgdl 与分数，不再分词机器文本、不重建 TF/长度/postings。
 *
 * 索引只持有构建时传入的文档快照；配置变化时由持有者（HealthEngine）整体替换成新实例，
 * 旧实例不再被引用，因此不会累积历史对象。内存驻留，不落盘。
 */
export class Bm25Index<T> {
  private readonly documents: readonly T[];
  private readonly lengths: number[] = [];
  private readonly frequencies: Map<string, number>[] = [];
  private readonly postings = new Map<string, number[]>();
  constructor(documents: readonly T[], toDocument: (item: T) => SearchDocument) {
    this.documents = documents;
    documents.forEach((item, index) => {
      const tokens = tokenize(documentText(toDocument(item)));
      const frequency = new Map<string, number>();
      for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
      this.lengths[index] = tokens.length;
      this.frequencies[index] = frequency;
      // 倒排表：term → 含该词的文档下标（每个文档每词只记一次），df 由它与候选集合求交得到。
      for (const term of frequency.keys()) {
        const docs = this.postings.get(term);
        if (docs) docs.push(index); else this.postings.set(term, [index]);
      }
    });
  }
  get size() { return this.documents.length; }
  /**
   * 对 candidates（文档下标，按配置顺序）评分并降序返回；省略时对全部文档评分。
   * IDF/avgdl 只基于候选集合，与原「过滤后候选语料」的评分语义一致；
   * 排序在分数相同时按候选顺序（即配置顺序）稳定排列。
   */
  search(query: string, candidates: readonly number[] = this.documents.map((_, index) => index)): SearchHit<T>[] {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length || !candidates.length) return [];
    const documentCount = candidates.length;
    let totalLength = 0;
    for (const index of candidates) totalLength += this.lengths[index];
    const averageLength = totalLength / documentCount;
    const inCandidates = new Set(candidates);
    const idfByTerm = new Map<string, number>();
    for (const term of terms) {
      const docs = this.postings.get(term);
      let df = 0;
      if (docs) for (const index of docs) if (inCandidates.has(index)) df += 1;
      idfByTerm.set(term, Math.log(1 + (documentCount - df + 0.5) / (df + 0.5)));
    }
    const hits: { position: number; document: T; score: number }[] = [];
    candidates.forEach((index, position) => {
      const frequency = this.frequencies[index];
      const length = this.lengths[index];
      let score = 0;
      for (const term of terms) {
        const tf = frequency.get(term);
        if (!tf) continue;
        const idf = idfByTerm.get(term) ?? 0;
        score += (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (length / (averageLength || 1))));
      }
      if (score > 0) hits.push({ position, document: this.documents[index], score });
    });
    return hits.sort((a, b) => b.score - a.score || a.position - b.position).map(({ document, score }) => ({ document, score }));
  }
}

/** 建立一次可复用的 BM25 索引的函数签名；服务启动与每次配置重载各调用一次。 */
export type SearchIndexBuilder = <T>(documents: readonly T[], toDocument: (item: T) => SearchDocument) => Bm25Index<T>;

/** 建立一次可复用的 BM25 索引；HealthEngine 在构造与 reload 时调用，之后查询只读该索引。 */
export function buildSearchIndex<T>(documents: readonly T[], toDocument: (item: T) => SearchDocument): Bm25Index<T> {
  return new Bm25Index(documents, toDocument);
}
