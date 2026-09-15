

  const focus = (image: HTMLElement | null, schedule?: (callback: () => void, delay: number) => unknown) => {
    if (!image?.isConnected) return { ok: false, error: "原图已变化，请重新采集" };
    const scheduler = schedule || globalThis.setTimeout.bind(globalThis);
    image.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    const previousOutline = image.style.outline;
    const previousOffset = image.style.outlineOffset;
    image.style.outline = "4px solid #1677ff";
    image.style.outlineOffset = "3px";
    image.click();
    scheduler(() => {
      image.style.outline = previousOutline;
      image.style.outlineOffset = previousOffset;
    }, 2000);
    return { ok: true };
  };

  export const ReviewImageFocus = { focus };
