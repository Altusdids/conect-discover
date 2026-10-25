-- Conect chat attachments and voice messages migration
-- Run this in the Supabase SQL Editor before deploying the updated Edge Function.
-- The bucket is private: clients must retrieve files only through a verified
-- matched conversation, using temporary signed URLs created by the Edge Function.

-- Also ensure the earlier reply/edit fields exist. These are no-ops if the
-- chat-message-actions migration has already been applied.
alter table public.messages
  add column if not exists reply_to_message_id uuid null
  references public.messages(id) on delete set null;

alter table public.messages
  add column if not exists edited_at timestamptz null;

create index if not exists messages_reply_to_message_id_idx
  on public.messages(reply_to_message_id);

alter table public.messages
  add column if not exists message_type text not null default 'text';

alter table public.messages
  add column if not exists attachment_path text null;

alter table public.messages
  add column if not exists attachment_name text null;

alter table public.messages
  add column if not exists attachment_mime_type text null;

alter table public.messages
  add column if not exists attachment_size bigint null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'messages_message_type_check'
      and conrelid = 'public.messages'::regclass
  ) then
    alter table public.messages
      add constraint messages_message_type_check
      check (message_type in ('text', 'file', 'voice'));
  end if;
end;
$$;

create index if not exists messages_attachment_path_idx
  on public.messages(attachment_path)
  where attachment_path is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-attachments',
  'chat-attachments',
  false,
  10485760,
  array[
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/rtf',
    'application/zip',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'audio/webm',
    'audio/ogg',
    'audio/mp4',
    'audio/mpeg',
    'audio/wav',
    'video/mp4',
    'video/webm'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = excluded.allowed_mime_types;
