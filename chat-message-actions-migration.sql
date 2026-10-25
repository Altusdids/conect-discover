-- Conect chat message actions migration
-- Apply this in the Supabase SQL Editor before deploying the updated
-- telegram-session-with-messaging-v3.ts Edge Function.
-- Replies reference another message in the same match; deleting the parent
-- message leaves the reply intact but clears its reference.
alter table public.messages
  add column if not exists reply_to_message_id uuid null
  references public.messages(id) on delete set null;

alter table public.messages
  add column if not exists edited_at timestamptz null;

create index if not exists messages_reply_to_message_id_idx
  on public.messages(reply_to_message_id);
