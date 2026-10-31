-- Minuta · esquema de base de datos (Postgres 13+)
-- Idempotente: se puede ejecutar varias veces sin efectos secundarios.

CREATE TABLE IF NOT EXISTS meetings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform        text NOT NULL CHECK (platform IN ('meet', 'teams', 'zoom', 'other')),
  title           text NOT NULL DEFAULT '',
  meeting_url     text,
  status          text NOT NULL DEFAULT 'recording'
                  CHECK (status IN ('recording', 'processing', 'done', 'failed')),
  stage           text,               -- transcribing | analyzing | emailing (mientras procesa o donde falló)
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  duration_sec    integer,
  audio_bytes     bigint  NOT NULL DEFAULT 0,
  chunk_count     integer NOT NULL DEFAULT 0,
  transcript      jsonb,              -- [{start,end,speaker,text}]
  transcript_text text,
  transcript_parts jsonb NOT NULL DEFAULT '{}'::jsonb, -- progreso por pista/segmento (reanudable)
  language        text,               -- idioma detectado / usado en la transcripción
  timezone        text,               -- zona horaria del navegador que grabó (p. ej. America/Mexico_City)
  analysis        jsonb,              -- salida estructurada de la IA
  email_to        text,
  email_id        text,
  emailed_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meetings_started_idx ON meetings (started_at DESC);

-- Migraciones aditivas (para bases creadas con versiones anteriores del esquema).
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS timezone text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS transcript_parts jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Audio en trozos de ~15 s tal como los sube la extensión. Se borran al terminar.
-- track: 'tab' (audio de la pestaña = los demás), 'mic' (tu micrófono) o 'mix' (versión antigua, mezclado).
-- seg:   la extensión reinicia la grabación cada ~20 min; cada segmento es un WebM independiente
--        que empieza en seg_start_ms desde el inicio de la reunión.
CREATE TABLE IF NOT EXISTS audio_chunks (
  meeting_id    uuid    NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  track         text    NOT NULL DEFAULT 'mix' CHECK (track IN ('tab', 'mic', 'mix')),
  seq           integer NOT NULL CHECK (seq >= 0),
  seg           integer NOT NULL DEFAULT 0 CHECK (seg >= 0),
  seg_start_ms  integer NOT NULL DEFAULT 0 CHECK (seg_start_ms >= 0),
  data          bytea   NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audio_chunks_track_pkey PRIMARY KEY (meeting_id, track, seq)
);

-- Migración desde la versión con una sola pista (clave primaria (meeting_id, seq)).
ALTER TABLE audio_chunks ADD COLUMN IF NOT EXISTS track text NOT NULL DEFAULT 'mix';
ALTER TABLE audio_chunks ADD COLUMN IF NOT EXISTS seg integer NOT NULL DEFAULT 0;
ALTER TABLE audio_chunks ADD COLUMN IF NOT EXISTS seg_start_ms integer NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audio_chunks_track_pkey') THEN
    ALTER TABLE audio_chunks DROP CONSTRAINT IF EXISTS audio_chunks_pkey;
    ALTER TABLE audio_chunks ADD CONSTRAINT audio_chunks_track_pkey PRIMARY KEY (meeting_id, track, seq);
  END IF;
END $$;

-- Ajustes de la cuenta (clave/valor).
CREATE TABLE IF NOT EXISTS settings (
  key    text PRIMARY KEY,
  value  text NOT NULL
);
