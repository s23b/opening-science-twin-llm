import {
  postGenomeRunResponse,
  streamGenomeRunResponse,
} from "@/features/digital-twin/genome-run";

/** Allows the export window or both fallback windows, plus machine waits. */
export const maxDuration = 1800;

export const POST = (request: Request): Response | Promise<Response> =>
  request.headers.get("accept") === "application/x-ndjson"
    ? streamGenomeRunResponse()
    : postGenomeRunResponse();
