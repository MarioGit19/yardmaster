// Browsers mark an animation's `finished` promise as handled, so cancelling a running WAAPI
// animation is silent; happy-dom rejects it unhandled. Match the spec.
if (typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function') {
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
    const animation = animate.apply(this, args);
    animation.finished.catch(() => {});
    return animation;
  };
}
