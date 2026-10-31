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

-- Audio en trozos de ~15 s tal como los sube la extensión. Se borran al terminar.
CREATE TABLE IF NOT EXISTS audio_chunks (
  meeting_id  uuid    NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  seq         integer NOT NULL CHECK (seq >= 0),
  data        bytea   NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, seq)
);

-- Ajustes de la cuenta (clave/valor).
CREATE TABLE IF NOT EXISTS settings (
  key    text PRIMARY KEY,
  value  text NOT NULL
);
