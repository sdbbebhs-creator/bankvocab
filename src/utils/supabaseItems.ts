import { supabase } from './supabaseClient';
import { ensureFSRSVocab, ensureFSRSGrammar } from './storage';
import type { VocabItem, GrammarItem } from '../types';

// ============================================================================
// LƯU TRỮ SUPABASE THEO 3 BẢNG
// ----------------------------------------------------------------------------
// - `vocab_items` / `grammar_items`: nội dung thẻ, mỗi thẻ 1 dòng
//   { user_id, id, data } (data không chứa thông số FSRS).
// - `study_data`: MỘT dòng cho mỗi người dùng { user_id, vocab, grammar }.
//   Cột `vocab` / `grammar` chứa một object JSON { [id thẻ]: thông số FSRS }
//   (state, stability (S), difficulty (D), last_review, next_review, ...).
//   Không dùng cột rời cho từng chỉ số, nên không cần đổi cấu trúc bảng.
// Mọi hàm ghi đều ném `SupabaseSyncError` khi thất bại để UI báo lỗi cho người dùng.
// ============================================================================

export type ItemKind = 'vocab' | 'grammar';
export type AnyItem = VocabItem | GrammarItem;
export type ItemOf<K extends ItemKind> = K extends 'vocab' ? VocabItem : GrammarItem;

export const ITEM_TABLE: Record<ItemKind, 'vocab_items' | 'grammar_items'> = {
  vocab: 'vocab_items',
  grammar: 'grammar_items',
};
export const STUDY_TABLE = 'study_data';

export type ItemRow = {
  user_id: string;
  id: string;
  data: Record<string, unknown>;
  updated_at?: string;
};

/** Thông số FSRS của một thẻ, lưu trong JSON của cột `vocab` / `grammar`. */
export type StudyEntry = {
  state: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  scheduled_days: number;
  elapsed_days: number;
  learning_steps: number;
  reviewDate: string | null;
  last_review: string | null;
  next_review: string;
};

/** { [id thẻ]: StudyEntry } */
export type StudyMap = Record<string, StudyEntry>;

/** Dòng `study_data` (một dòng / người dùng). Cột JSON có thể là jsonb hoặc text. */
export type StudyRow = {
  user_id: string;
  vocab?: unknown;
  grammar?: unknown;
  updated_at?: string;
};

/** Các trường FSRS — nằm trong `study_data`, không lưu vào `data` của thẻ. */
const FSRS_KEYS = [
  'stability',
  'difficulty',
  'reps',
  'lapses',
  'state',
  'last_review',
  'next_review',
  'reviewDate',
  'elapsed_days',
  'scheduled_days',
  'learning_steps',
  'interval',
  'repetition',
  'easeFactor',
] as const;

const PAGE_SIZE = 1000;
const WRITE_CHUNK_ROWS = 200;
// Giữ mỗi request nhỏ (thẻ có thể chứa ảnh/âm thanh base64)
const WRITE_CHUNK_BYTES = 3_000_000;

// ---------------------------------------------------------------------------
// Lỗi
// ---------------------------------------------------------------------------

export class SupabaseSyncError extends Error {
  constructor(
    /** Hành động đang làm, ví dụ "lưu từ vựng mới" */
    public readonly action: string,
    public readonly cause?: unknown
  ) {
    super(`Không thể ${action}: ${explainCause(cause)}`);
    this.name = 'SupabaseSyncError';
  }
}

function explainCause(cause: unknown): string {
  const err = (cause ?? {}) as { message?: string; code?: string };
  const message = err.message || String(cause ?? '');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'mất kết nối mạng.';
  if (/fetch|network|load failed|timeout/i.test(message)) return 'không kết nối được Supabase, hãy kiểm tra mạng.';
  if (err.code === '42501' || /row-level security|permission denied/i.test(message)) return 'không có quyền ghi (RLS). Hãy đăng nhập lại.';
  if (/JWT|not signed in|chưa đăng nhập/i.test(message)) return 'phiên đăng nhập đã hết hạn, hãy đăng nhập lại.';
  return message || 'lỗi không xác định.';
}

/** Thông báo dễ hiểu cho Toast từ bất kỳ lỗi nào. */
export function describeSupabaseError(error: unknown): string {
  if (error instanceof SupabaseSyncError) return error.message;
  return `Lỗi Supabase: ${explainCause(error)}`;
}

function fail(action: string, cause: unknown): never {
  console.error('Supabase Error:', action, cause);
  throw new SupabaseSyncError(action, cause);
}

async function requireUserId(action: string): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (error || !userId) fail(action, error ?? new Error('Chưa đăng nhập'));
  return userId;
}

// ---------------------------------------------------------------------------
// Chuyển đổi thẻ <-> dòng
// ---------------------------------------------------------------------------

/** Sinh UUID duy nhất cho thẻ mới (fallback cho trình duyệt rất cũ). */
export function newItemId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Đảm bảo mọi thẻ đều có id; thẻ thiếu id được gán UUID mới. */
export function withItemId<T extends { id?: string }>(item: T): T & { id: string } {
  return { ...item, id: item.id || newItemId() };
}

const normalize = <K extends ItemKind>(kind: K, raw: unknown): ItemOf<K> =>
  (kind === 'vocab' ? ensureFSRSVocab(raw) : ensureFSRSGrammar(raw)) as ItemOf<K>;

/** Nội dung thẻ (không có FSRS) để lưu vào cột `data`. */
function contentOf(item: AnyItem): Record<string, unknown> {
  const data: Record<string, unknown> = { ...item };
  for (const key of FSRS_KEYS) delete data[key];
  delete data.id;
  return data;
}

/** Các trường FSRS hiện tại của một thẻ. */
export function pickFSRSFields(item: AnyItem): Partial<AnyItem> {
  const out: Record<string, unknown> = {};
  for (const key of FSRS_KEYS) if (key in item) out[key] = (item as unknown as Record<string, unknown>)[key];
  return out as Partial<AnyItem>;
}

const toInt = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0);
const toNum = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function toItemRow(userId: string, item: AnyItem) {
  return { user_id: userId, id: item.id, data: contentOf(item), updated_at: new Date().toISOString() };
}

/** Thông số FSRS của một thẻ để lưu vào JSON của `study_data`. */
export function toStudyEntry(item: AnyItem): StudyEntry {
  return {
    state: toInt(item.state),
    stability: toNum(item.stability),
    difficulty: toNum(item.difficulty),
    reps: toInt(item.reps),
    lapses: toInt(item.lapses),
    scheduled_days: toInt(item.scheduled_days),
    elapsed_days: toInt(item.elapsed_days),
    learning_steps: toInt(item.learning_steps),
    reviewDate: item.reviewDate || null,
    last_review: item.last_review || null,
    next_review: item.next_review || new Date().toISOString(),
  };
}

/** Thông số FSRS đã lưu, theo đúng tên trường của thẻ. */
export function studyEntryToFields(entry: Partial<StudyEntry>): Partial<AnyItem> {
  const fields: Record<string, unknown> = {};
  const num = (key: keyof StudyEntry) => {
    const value = entry[key];
    if (typeof value === 'number' && Number.isFinite(value)) fields[key] = value;
  };
  (['state', 'stability', 'difficulty', 'reps', 'lapses', 'scheduled_days', 'elapsed_days', 'learning_steps'] as const).forEach(num);
  if ('scheduled_days' in fields) fields.interval = fields.scheduled_days;
  if ('reps' in fields) fields.repetition = fields.reps;
  if (typeof entry.next_review === 'string') fields.next_review = entry.next_review;
  if (typeof entry.last_review === 'string') fields.last_review = entry.last_review;
  const reviewDate = entry.reviewDate || (typeof entry.next_review === 'string' ? entry.next_review.slice(0, 10) : undefined);
  if (reviewDate) fields.reviewDate = reviewDate;
  return fields as Partial<AnyItem>;
}

/**
 * Đọc JSON trong cột `vocab` / `grammar`: chấp nhận jsonb hoặc chuỗi JSON,
 * dạng mới { [id]: StudyEntry } hoặc dạng cũ là mảng thẻ đầy đủ.
 */
function parseJSONColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseStudyMap(value: unknown): StudyMap {
  const parsed = parseJSONColumn(value);
  const out: StudyMap = {};
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === 'object' && typeof (item as AnyItem).id === 'string') {
        out[(item as AnyItem).id] = toStudyEntry(item as AnyItem);
      }
    }
    return out;
  }
  if (parsed && typeof parsed === 'object') {
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (entry && typeof entry === 'object') out[id] = entry as StudyEntry;
    }
  }
  return out;
}

/**
 * Ghép dòng nội dung với dòng FSRS thành một thẻ hoàn chỉnh. Nếu chưa có dòng
 * `study_data`, dùng `fallbackFSRS` (thẻ đang có trên máy) hoặc FSRS cũ còn
 * nằm trong `data`, cuối cùng là giá trị mặc định của thẻ mới.
 */
export function rowsToItem<K extends ItemKind>(
  kind: K,
  row: Pick<ItemRow, 'id' | 'data'>,
  study?: Partial<StudyEntry> | null,
  fallbackFSRS?: Partial<AnyItem>
): ItemOf<K> {
  return normalize(kind, {
    ...row.data,
    ...(fallbackFSRS || {}),
    ...(study ? studyEntryToFields(study) : {}),
    id: row.id,
  });
}

/** Chia mảng thành các gói nhỏ theo số dòng và dung lượng. */
function chunk<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (batch.length > 0 && (batch.length >= WRITE_CHUNK_ROWS || bytes + size > WRITE_CHUNK_BYTES)) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(row);
    bytes += size;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

const label = (kind: ItemKind) => (kind === 'vocab' ? 'từ vựng' : 'ngữ pháp');

// ---------------------------------------------------------------------------
// Đọc
// ---------------------------------------------------------------------------

async function fetchAll<T>(table: string, columns: string, userId: string, orderBy: string, action: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq('user_id', userId)
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) fail(action, error);
    rows.push(...((data as T[]) || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function readStudyRows(userId: string, action: string): Promise<StudyRow[]> {
  const { data, error } = await supabase.from(STUDY_TABLE).select('*').eq('user_id', userId);
  if (error) fail(action, error);
  return (data as StudyRow[]) || [];
}

/** Thẻ đầy đủ trong bản chụp kiểu cũ (cột chứa mảng thẻ) — dùng khi Supabase chưa có thẻ nào. */
function legacyItemsOf<K extends ItemKind>(kind: K, rows: StudyRow[]): ItemOf<K>[] {
  const out: ItemOf<K>[] = [];
  for (const row of rows) {
    const parsed = parseJSONColumn(row[kind]);
    if (!Array.isArray(parsed)) continue;
    for (const raw of parsed) {
      if (raw && typeof raw === 'object' && typeof (raw as AnyItem).id === 'string') out.push(normalize(kind, raw));
    }
  }
  return out;
}

/** Gộp (các) dòng `study_data` của người dùng thành 2 bảng tra cứu theo id thẻ. */
export function mergeStudyRows(rows: StudyRow[]): Record<ItemKind, StudyMap> {
  const maps: Record<ItemKind, StudyMap> = { vocab: {}, grammar: {} };
  for (const row of rows) {
    Object.assign(maps.vocab, parseStudyMap(row.vocab));
    Object.assign(maps.grammar, parseStudyMap(row.grammar));
  }
  return maps;
}

// Các lần ghi `study_data` chạy lần lượt để không ghi đè lên nhau.
let studyWriteQueue: Promise<unknown> = Promise.resolve();

/**
 * Đọc JSON hiện tại của cột `kind`, sửa bằng `mutate`, rồi ghi lại vào đúng cột đó.
 * Cập nhật dòng của người dùng; nếu chưa có dòng nào thì tạo mới.
 */
function mutateStudyMap(kind: ItemKind, action: string, mutate: (map: StudyMap) => void): Promise<void> {
  const run = async () => {
    const userId = await requireUserId(action);
    const rows = await readStudyRows(userId, action);
    const map = mergeStudyRows(rows)[kind];
    mutate(map);
    const patch = { [kind]: map };
    console.log('Saving to Supabase:', STUDY_TABLE, { user_id: userId, column: kind, items: Object.keys(map).length });

    if (rows.length > 0) {
      const { error } = await supabase.from(STUDY_TABLE).update(patch).eq('user_id', userId);
      if (error) fail(action, error);
      return;
    }
    const { error } = await supabase.from(STUDY_TABLE).insert({ user_id: userId, vocab: {}, grammar: {}, ...patch });
    if (error) fail(action, error);
  };
  const next = studyWriteQueue.then(run, run);
  studyWriteQueue = next.catch(() => undefined);
  return next;
}

export interface SupabaseUserData {
  vocab: VocabItem[];
  grammar: GrammarItem[];
  /** Thẻ chưa có dòng `study_data` (dữ liệu cũ) — cần tạo bổ sung. */
  missingStudy: { vocab: VocabItem[]; grammar: GrammarItem[] };
  /** Thẻ trong bản chụp `study_data` kiểu cũ (mảng thẻ đầy đủ), nếu có. */
  legacy: { vocab: VocabItem[]; grammar: GrammarItem[] };
}

/** Tải toàn bộ thẻ + FSRS của tài khoản đang đăng nhập, thẻ mới nhất lên đầu. */
export async function fetchAllUserData(): Promise<SupabaseUserData> {
  const action = 'tải dữ liệu từ Supabase';
  const userId = await requireUserId(action);
  const [vocabRows, grammarRows, studyRows] = await Promise.all([
    fetchAll<ItemRow>(ITEM_TABLE.vocab, 'user_id,id,data,updated_at', userId, 'id', action),
    fetchAll<ItemRow>(ITEM_TABLE.grammar, 'user_id,id,data,updated_at', userId, 'id', action),
    readStudyRows(userId, action),
  ]);

  const studyMaps = mergeStudyRows(studyRows);
  const missingStudy: SupabaseUserData['missingStudy'] = { vocab: [], grammar: [] };
  const build = <K extends ItemKind>(kind: K, rows: ItemRow[]): ItemOf<K>[] =>
    rows
      .map((row) => {
        const study = studyMaps[kind][row.id];
        // Thẻ cũ: FSRS vẫn nằm trong `data` → rowsToItem đọc từ đó
        const item = rowsToItem(kind, row, study);
        if (!study) (missingStudy[kind] as AnyItem[]).push(item);
        return item;
      })
      .sort((a, b) => String((b as AnyItem).createdAt || '').localeCompare(String((a as AnyItem).createdAt || '')));

  return {
    vocab: build('vocab', vocabRows),
    grammar: build('grammar', grammarRows),
    missingStudy,
    legacy: { vocab: legacyItemsOf('vocab', studyRows), grammar: legacyItemsOf('grammar', studyRows) },
  };
}

// ---------------------------------------------------------------------------
// Ghi
// ---------------------------------------------------------------------------

/**
 * THÊM thẻ mới:
 *  1. Insert nội dung vào `vocab_items` / `grammar_items` và nhận lại id.
 *  2. Ghi FSRS ban đầu của thẻ (theo id vừa tạo) vào JSON trong `study_data`.
 * Nếu bước 2 lỗi, dòng ở bước 1 được xóa để không để lại thẻ thiếu FSRS.
 */
export async function createItem<K extends ItemKind>(kind: K, item: ItemOf<K>): Promise<ItemOf<K>> {
  const action = `lưu ${label(kind)} mới lên Supabase`;
  const userId = await requireUserId(action);
  const itemRow = toItemRow(userId, item.id ? item : withItemId(item));

  console.log('Saving to Supabase:', ITEM_TABLE[kind], itemRow);
  const { data: inserted, error: insertError } = await supabase
    .from(ITEM_TABLE[kind])
    .insert(itemRow)
    .select('id,data')
    .single();
  if (insertError || !inserted) fail(action, insertError ?? new Error('Supabase không trả về id của thẻ mới'));

  const created = { ...item, id: (inserted as ItemRow).id } as ItemOf<K>;
  const study = toStudyEntry(created);
  try {
    await mutateStudyMap(kind, `lưu thông số FSRS cho ${label(kind)} mới`, (map) => {
      map[created.id] = study;
    });
  } catch (studyError) {
    const { error: rollbackError } = await supabase
      .from(ITEM_TABLE[kind])
      .delete()
      .eq('user_id', userId)
      .eq('id', created.id);
    if (rollbackError) console.error('Supabase Error: rollback failed', rollbackError);
    throw studyError;
  }

  return rowsToItem(kind, inserted as ItemRow, study);
}

/** Cập nhật nội dung (không gồm FSRS) của một thẻ trong `vocab_items` / `grammar_items`. */
export async function updateItemContent(kind: ItemKind, item: AnyItem): Promise<void> {
  const action = `lưu thay đổi ${label(kind)} lên Supabase`;
  const userId = await requireUserId(action);
  const row = toItemRow(userId, item);
  console.log('Saving to Supabase:', ITEM_TABLE[kind], row);
  const { error } = await supabase.from(ITEM_TABLE[kind]).upsert(row, { onConflict: 'user_id,id' });
  if (error) fail(action, error);
}

/** ÔN TẬP: cập nhật thông số FSRS của thẻ trong JSON của `study_data`. */
export async function saveStudyData(kind: ItemKind, item: AnyItem): Promise<void> {
  await saveStudyDataBatch(kind, [item]);
}

/** Lưu FSRS của nhiều thẻ một lúc (đánh dấu đã ôn hàng loạt, bổ sung dữ liệu cũ). */
export async function saveStudyDataBatch(kind: ItemKind, items: AnyItem[]): Promise<void> {
  if (items.length === 0) return;
  const action = `lưu kết quả ôn tập ${label(kind)} lên Supabase`;
  await mutateStudyMap(kind, action, (map) => {
    for (const item of items) map[item.id] = toStudyEntry(item);
  });
}

/** SỬA thẻ: lưu nội dung rồi FSRS (ngày ôn có thể đã được chỉnh trong form). */
export async function saveItem(kind: ItemKind, item: AnyItem): Promise<void> {
  await updateItemContent(kind, item);
  await saveStudyData(kind, item);
}

/** Lưu nhiều thẻ (nhập file, bộ mẫu): nội dung trước, FSRS sau. */
export async function bulkSaveItems(kind: ItemKind, items: AnyItem[]): Promise<void> {
  if (items.length === 0) return;
  const action = `lưu ${items.length} ${label(kind)} lên Supabase`;
  const userId = await requireUserId(action);
  for (const rows of chunk(items.map((item) => toItemRow(userId, item)))) {
    console.log('Saving to Supabase:', ITEM_TABLE[kind], `${rows.length} rows`);
    const { error } = await supabase.from(ITEM_TABLE[kind]).upsert(rows, { onConflict: 'user_id,id' });
    if (error) fail(action, error);
  }
  await saveStudyDataBatch(kind, items);
}

/** XÓA thẻ: bỏ FSRS của thẻ khỏi JSON trong `study_data` rồi xóa dòng nội dung. */
export async function deleteItems(kind: ItemKind, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const action = `xóa ${label(kind)} trên Supabase`;
  const userId = await requireUserId(action);
  await mutateStudyMap(kind, action, (map) => {
    for (const id of ids) delete map[id];
  });
  for (let i = 0; i < ids.length; i += WRITE_CHUNK_ROWS) {
    const part = ids.slice(i, i + WRITE_CHUNK_ROWS);
    console.log('Deleting from Supabase:', { table: ITEM_TABLE[kind], user_id: userId, ids: part });
    const { error } = await supabase.from(ITEM_TABLE[kind]).delete().eq('user_id', userId).in('id', part);
    if (error) fail(action, error);
  }
}
