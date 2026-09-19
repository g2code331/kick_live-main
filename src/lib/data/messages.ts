/**
 * Messaging client — the browser's typed door to the phase-15 endpoints.
 *
 * A conversation inbox between an ordinary account and the staff desk (admins + media). Ordinary users hold
 * one conversation with "whoever runs this"; staff see and answer the whole desk. Every write is a POST to
 * the Worker, which runs it as the caller's JWT through a SECURITY DEFINER function — a body never names a
 * sender.
 */
import { api } from '../api/index.ts';
import type { ApiResult } from '../api/index.ts';

export interface MessageThreadSummary {
  id: number;
  user_id: string;
  subject: string | null;
  status: 'open' | 'closed';
  last_message_at: string;
  last_message_preview: string | null;
  unread: boolean;
  user_name: string | null;
}

export interface Message {
  id: number;
  sender_id: string | null;
  sender_is_staff: boolean;
  body: string;
  created_at: string;
  sender_name: string | null;
}

export interface ThreadDetail {
  id: number;
  userId: string;
  subject: string | null;
  status: 'open' | 'closed';
  lastMessageAt: string;
}

export interface ThreadsResponse {
  ok: boolean;
  staff: boolean;
  threads: MessageThreadSummary[];
}

export interface ThreadResponse {
  ok: boolean;
  thread: ThreadDetail;
  messages: Message[];
}

export interface SendResult {
  ok: boolean;
  threadId: number;
  messageId: number;
}

export interface UnreadResult {
  ok: boolean;
  count: number;
}

/** The caller's conversation list. */
export function listThreads(limit = 50): Promise<ApiResult<ThreadsResponse>> {
  return api.get<ThreadsResponse>('/messages/threads', { query: { limit } });
}

/** One thread's messages; the server marks it read for the caller's side. */
export function getThread(id: number, limit = 200): Promise<ApiResult<ThreadResponse>> {
  return api.get<ThreadResponse>(`/messages/threads/${id}`, { query: { limit } });
}

/** Send into an existing thread, or open one (non-staff) by passing threadId = null. */
export function sendMessage(threadId: number | null, body: string, subject?: string): Promise<ApiResult<SendResult>> {
  return api.post<SendResult>('/messages/send', { threadId, body, subject });
}

/** Staff-only: open a thread addressed to a chosen account. */
export function startThread(userId: string, body: string, subject?: string): Promise<ApiResult<SendResult>> {
  return api.post<SendResult>('/messages/start', { userId, body, subject });
}

/** Close or reopen a thread. */
export function setThreadStatus(id: number, status: 'open' | 'closed'): Promise<ApiResult<{ ok: boolean; status: string }>> {
  return api.post<{ ok: boolean; status: string }>(`/messages/threads/${id}/status`, { status });
}

/** Unread conversation count for the badge. */
export function unreadCount(): Promise<ApiResult<UnreadResult>> {
  return api.get<UnreadResult>('/messages/unread');
}
