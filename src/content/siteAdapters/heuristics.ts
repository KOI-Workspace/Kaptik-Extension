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
 * 고른 박스에서 '같은 컬럼'을 유지하는 가장 바깥 조상(컬럼 래퍼)까지 끌어올린다.
 * 컬럼 안 개별 박스(예: '댓글 작성')에 패널이 끼어 들어가는 것을 막고,
 * 컬럼 전체 맨 위에 들어가 모든 박스를 아래로 밀어내도록 한다.
 */
function climbToColumnRoot(el: HTMLElement, video: HTMLVideoElement): HTMLElement {
  let col = el;
  while (col.parentElement && col.parentElement !== document.body) {
    const parent = col.parentElement;
    if (parent.contains(video)) break; // 영상까지 품으면 너무 넓음 → 멈춤
    const pr = parent.getBoundingClientRect();
    const cr = col.getBoundingClientRect();
    // 부모 폭이 갑자기 커지지 않으면(= 여전히 같은 세로 컬럼) 계속 올라간다.
    if (cr.width > 0 && pr.width <= cr.width * 1.25) {
      col = parent;
    } else break;
  }
  return col;
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
    return climbToColumnRoot(rightCol[0], video);
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
    return climbToColumnRoot(belowCol[0], video);
  }

  return null;
}
