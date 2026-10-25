/* 写剪贴板。Electron 里 navigator.clipboard 在部分协议下不可用，退回 textarea 那条老路 */
export async function copyText(t: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(t);
    return;
  } catch {
    /* 掉到下面的兜底 */
  }
  const ta = document.createElement("textarea");
  ta.value = t;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}
