import type { SiteAdapter } from "./types";
import { youtubeAdapter } from "./youtube";
import { weverseAdapter } from "./weverse";
import { instagramAdapter } from "./instagram";

/** 등록된 모든 사이트 어댑터 */
export const adapters: SiteAdapter[] = [
  youtubeAdapter,
  weverseAdapter,
  instagramAdapter,
];

/** 현재 URL에 맞는 어댑터를 찾는다 (없으면 null) */
export function resolveAdapter(url: string = location.href): SiteAdapter | null {
  return adapters.find((a) => a.matches(url)) ?? null;
}

export type { SiteAdapter };
