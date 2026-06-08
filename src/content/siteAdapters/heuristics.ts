/**
 * 클래스명이 난독화되는 사이트(Weverse·Instagram 등)를 위한 공통 DOM 추론 헬퍼.
 * 고정 셀렉터 대신 video의 '위치·크기'를 기준으로 영상 박스와 도킹 컬럼을 찾는다.
 */

/**
 * 자막/패널이 영상 밖으로 번지지 않도록, video와 크기가 거의 같은
 * (레터박스 없는) 가장 바깥 조상을 오버레이 컨테이너로 반환한다.
 */
export function findVideoBox(video: HTMLVideoElement): HTMLElement | null {
  if (!video.parentElement) return null;
  const vRect = video.getBoundingClientRect();
  let node: HTMLElement = video.parentElement;
  while (node.parentElement && node.parentElement !== document.body) {
    const pr = node.parentElement.getBoundingClientRect();
    const sameBox =
      vRect.width > 0 &&
      pr.width <= vRect.width * 1.06 &&
      pr.height <= vRect.height * 1.06;
    if (sameBox) node = node.parentElement;
    else break;
  }
  return node;
}

/**
 * 패널을 도킹할 컬럼을 찾는다 (없으면 null → 오버레이 폴백).
 * - 넓은 화면: 영상 오른쪽의 세로 컬럼(댓글/채팅)
 * - 좁은 화면: 영상 바로 아래의 컬럼
 * 둘 다 영상을 가리지 않고 컬럼 콘텐츠를 아래로 밀어 넣는 위치다.
 */
export function findDockColumn(video: HTMLVideoElement): HTMLElement | null {
  const vRect = video.getBoundingClientRect();
  if (vRect.width === 0) return null;

  const all = Array.from(
    document.querySelectorAll<HTMLElement>("div, section, aside"),
  ).filter((el) => !el.contains(video)); // 영상을 품은 큰 래퍼는 제외

  // 1순위(넓은 화면): 영상 오른쪽의 세로 컬럼
  const rightCol = all.filter((el) => {
    const r = el.getBoundingClientRect();
    return (
      r.left >= vRect.right - 80 &&
      r.width >= 260 &&
      r.width <= 720 &&
      r.height >= 320
    );
  });
  if (rightCol.length > 0) {
    rightCol.sort(
      (a, b) =>
        b.getBoundingClientRect().height - a.getBoundingClientRect().height,
    );
    return rightCol[0];
  }

  // 2순위(좁은 화면): 영상 바로 아래의 컬럼
  const belowCol = all.filter((el) => {
    const r = el.getBoundingClientRect();
    return (
      r.top >= vRect.bottom - 40 &&
      r.width >= 260 &&
      r.height >= 160 &&
      r.left < vRect.right &&
      r.right > vRect.left
    );
  });
  if (belowCol.length > 0) {
    belowCol.sort(
      (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
    );
    return belowCol[0];
  }

  return null;
}
