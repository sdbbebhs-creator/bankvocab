import { supabase } from './supabaseClient';
import type { VocabItem, GrammarItem } from '../types';
import { ensureFSRSVocab, ensureFSRSGrammar, fetchAllUserData, bulkSaveItems, deleteItems } from './supabaseItems';

// ============================================================================
// CLOUD SYNC (Supabase-only)
// ----------------------------------------------------------------------------
// The original project used /api/sync backed by Netlify DB for settings and
// review logs. The app's actual cards + FSRS are already stored directly in
// Supabase (vocab_items / grammar_items / study_data). This adapter keeps the
// existing App API but removes the Netlify dependency so the project works on
// Vercel with the new Supabase project.
//
// Settings and review logs remain local for now. Card content + FSRS are fully
// persisted in Supabase and are the source of truth across devices.
// ============================================================================

const SYNC_STATE_PREFIX = 'vocabbank_sync_state_v2:';
const DATA_OWNER_KEY = 'vocabbank_data_owner';

interface SyncState {
  vocab: Record<string, string>;
  grammar: Record<string, string>;
  logsPushedThrough: string;
}

export interface SyncedData {
  vocab: VocabItem[];
  grammar: GrammarItem[];
  settingsChanged: boolean;
  logsChanged: boolean;
}

function hashString(str: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = (Math.imul(h2, 33) + c) | 0;
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${str.length.toString(36)}`;
}

function hashItem(item: object): string {
  return hashString(JSON.stringify(item));
}

function hashMap(items: Array<{ id: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  items.forEach((item) => {
    out[item.id] = hashItem(item);
  });
  return out;
}

function loadSyncState(userId: string): SyncState | null {
  try {
    const raw = localStorage.getItem(SYNC_STATE_PREFIX + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      vocab: parsed.vocab || {},
      grammar: parsed.grammar || {},
      logsPushedThrough: parsed.logsPushedThrough || '',
    };
  } catch {
    return null;
  }
}

function saveSyncState(userId: string, state: SyncState): void {
  try {
    localStorage.setItem(SYNC_STATE_PREFIX + userId, JSON.stringify(state));
  } catch {}
}

function getDataOwner(): string | null {
  try {
    return localStorage.getItem(DATA_OWNER_KEY);
  } catch {
    return null;
  }
}

function setDataOwner(userId: string): void {
  try {
    localStorage.setItem(DATA_OWNER_KEY, userId);
  } catch {}
}

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = pushChain.then(task, task);
  pushChain = run.catch(() => undefined);
  return run;
}

let pushChain: Promise<unknown> = Promise.resolve();

/**
 * Save the current card lists directly to Supabase. This is deliberately
 * independent of any /api route, so Vercel can serve the app as a normal Vite
 * deployment without Netlify Functions.
 */
export function pushLocalChanges(
  userId: string,
  vocab: VocabItem[],
  grammar: GrammarItem[]
): Promise<boolean> {
  return serialize(async () => {
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session?.user || sessionData.session.user.id !== userId) return false;

    const previousOwner = getDataOwner();
    const previousState = previousOwner === userId ? loadSyncState(userId) : null;

    // Upsert current cards. Direct writes are idempotent and safe to retry.
    await bulkSaveItems('vocab', vocab.map(ensureFSRSVocab));
    await bulkSaveItems('grammar', grammar.map(ensureFSRSGrammar));

    // If this browser removed cards since the last snapshot, remove those same
    // cards from Supabase. We only do this when we have a local snapshot for the
    // same account; a first sync never deletes remote data.
    if (previousState) {
      const currentVocab = new Set(vocab.map((item) => item.id));
      const currentGrammar = new Set(grammar.map((item) => item.id));
      const deletedVocab = Object.keys(previousState.vocab).filter((id) => !currentVocab.has(id));
      const deletedGrammar = Object.keys(previousState.grammar).filter((id) => !currentGrammar.has(id));
      if (deletedVocab.length) await deleteItems('vocab', deletedVocab);
      if (deletedGrammar.length) await deleteItems('grammar', deletedGrammar);
    }

    setDataOwner(userId);
    saveSyncState(userId, {
      vocab: hashMap(vocab),
      grammar: hashMap(grammar),
      logsPushedThrough: previousState?.logsPushedThrough || '',
    });
    return true;
  });
}

/**
 * Load cards directly from Supabase. Existing local data is only used as a seed
 * when the new Supabase project is completely empty, preserving the original
 * app's migration-friendly behavior.
 */
export function pullAndMerge(
  userId: string,
  localVocab: VocabItem[],
  localGrammar: GrammarItem[]
): Promise<SyncedData> {
  return serialize(async () => {
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session?.user || sessionData.session.user.id !== userId) {
      throw new Error('Not signed in');
    }

    const remote = await fetchAllUserData();
    let vocab = remote.vocab.map(ensureFSRSVocab);
    let grammar = remote.grammar.map(ensureFSRSGrammar);

    const hasRemote = vocab.length > 0 || grammar.length > 0;
    const hasLocal = localVocab.length > 0 || localGrammar.length > 0;

    // First login to a brand-new Supabase project: preserve existing local cards
    // by uploading them once. Never merge a different account's local data.
    const localBelongsToAnotherUser = !!getDataOwner() && getDataOwner() !== userId;
    if (!hasRemote && hasLocal && !localBelongsToAnotherUser) {
      vocab = localVocab.map(ensureFSRSVocab);
      grammar = localGrammar.map(ensureFSRSGrammar);
      await bulkSaveItems('vocab', vocab);
      await bulkSaveItems('grammar', grammar);
    }

    setDataOwner(userId);
    saveSyncState(userId, {
      vocab: hashMap(vocab),
      grammar: hashMap(grammar),
      logsPushedThrough: '',
    });

    return {
      vocab,
      grammar,
      settingsChanged: false,
      logsChanged: false,
    };
  });
}

