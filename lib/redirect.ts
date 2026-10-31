/**
 * Redirección 303 tras un formulario (POST → GET). Se usa una ruta relativa para no
 * depender del host que reconstruye el servidor (que puede diferir del que usa el navegador).
 */
export function seeOther(_req: Request, path: string): Response {
  return new Response(null, { status: 303, headers: { Location: path } });
}
