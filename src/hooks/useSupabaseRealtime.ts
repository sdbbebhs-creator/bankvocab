import { useEffect, useRef } from 'react';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { supabase } from '../utils/supabaseClient';
import { ITEM_TABLE, STUDY_TABLE, parseStudyMap, type ItemKind, type ItemRow, type StudyMap, type StudyRow } from '../utils/supabaseItems';

/**
 * Supabase Realtime cho `vocab_items`, `grammar_items` và `study_data`.
 * Mỗi sự kiện INSERT / UPDATE / DELETE của tài khoản đang đăng nhập được chuyển
 * thẳng cho các handler để App cập nhật state ngay, không cần F5.
 */
export interface RealtimeHandlers {
  onItemUpsert: (kind: ItemKind, row: ItemRow) => void;
  onItemDelete: (kind: ItemKind, id: string) => void;
  /** FSRS của các thẻ `kind`, đọc từ JSON trong cột `vocab` / `grammar` của `study_data`. */
  onStudyUpsert: (kind: ItemKind, entries: StudyMap) => void;
  /** Kênh vừa kết nối lại hoặc tab vừa mở lại — có thể đã lỡ sự kiện, nên tải lại. */
  onResync: () => void;
}

const KINDS: ItemKind[] = ['vocab', 'grammar'];

export function useSupabaseRealtime(userId: string | null, accessToken: string | null, handlers: RealtimeHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Giữ socket realtime xác thực theo token mới nhất (RLS cần auth.uid()).
  useEffect(() => {
    if (accessToken) supabase.realtime.setAuth(accessToken);
  }, [accessToken]);

  useEffect(() => {
    if (!userId) return;

    // DELETE không lọc được phía server → kiểm tra user_id ở đây.
    const isMine = (row: { user_id?: string } | null | undefined) => !row?.user_id || row.user_id === userId;

    const onItemChange = (kind: ItemKind) => (payload: RealtimePostgresChangesPayload<ItemRow>) => {
      try {
        if (payload.eventType === 'DELETE') {
          const old = payload.old as Partial<ItemRow>;
          if (old?.id && isMine(old)) handlersRef.current.onItemDelete(kind, old.id);
          return;
        }
        const row = payload.new as ItemRow;
        if (row?.id && row.data && isMine(row)) handlersRef.current.onItemUpsert(kind, row);
      } catch (error) {
        console.error('Supabase Realtime Error:', error);
      }
    };

    const onStudyChange = (payload: RealtimePostgresChangesPayload<StudyRow>) => {
      try {
        if (payload.eventType === 'DELETE') return;
        const row = payload.new as StudyRow;
        if (!row || !isMine(row)) return;
        // Cột không đổi có thể bị lược khỏi sự kiện UPDATE → chỉ xử lý cột có mặt.
        for (const kind of KINDS) {
          if (row[kind] != null) handlersRef.current.onStudyUpsert(kind, parseStudyMap(row[kind]));
        }
      } catch (error) {
        console.error('Supabase Realtime Error:', error);
      }
    };

    const filter = `user_id=eq.${userId}`;
    const channel: RealtimeChannel = supabase.channel(`user-data:${userId}`);

    for (const kind of KINDS) {
      const table = ITEM_TABLE[kind];
      channel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table, filter }, onItemChange(kind))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table, filter }, onItemChange(kind))
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table }, onItemChange(kind));
    }
    channel
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: STUDY_TABLE, filter }, onStudyChange)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: STUDY_TABLE, filter }, onStudyChange);

    let hasSubscribed = false;
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('Supabase Realtime: đã kết nối', channel.topic);
        if (hasSubscribed) handlersRef.current.onResync();
        hasSubscribed = true;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.error('Supabase Realtime Error:', status, err);
      }
    });

    const onVisible = () => {
      if (document.visibilityState === 'visible') handlersRef.current.onResync();
    };
    const onOnline = () => handlersRef.current.onResync();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      supabase.removeChannel(channel);
    };
  }, [userId]);
}
