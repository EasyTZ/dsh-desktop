'use strict';

// 共用的迷你 React：给「客户端半冒烟测试」用（在 node 里真实执行插件的 client.js）。
//
// 原封搬自 dsh-market 仓库 test/client-smoke.test.js 里的同一段，只做了参数化，
// 语义没动。搬过来是因为 app 仓库这边原先各测试手搓了一份**空壳版**（useState
// 原样返回初值、useEffect 是空函数），而 CLAUDE.md「客户端半怎么测」一节明确说
// 过那样测不到东西：面板会永远停在早退分支上，真正复杂的那棵树（分组、列表、
// 按钮）一行都不执行 —— 测试全绿，而面板在浏览器里打不开。验证过：把 market 的
// desktop.plugins 那个 bug 放回去，空壳版 hooks 照样 37 个用例全过。
//
// 所以状态要真存、effect 要真跑、setState 要真触发重渲染。三十来行，换来的是这个
// 测试真的在测东西。

/**
 * 造一份够用的假 React。
 * @returns {{ jsxRuntime: any, hooks: any, render: (render: () => any) => Promise<any> }}
 */
function createFakeReact() {
  const jsxRuntime = {
    jsx: (type, props, key) => ({ type, props: props || {}, key }),
    jsxs: (type, props, key) => ({ type, props: props || {}, key }),
    Fragment: Symbol('Fragment'),
  };

  const cells = [];
  let cursor = 0;
  let dirty = false;
  const effects = [];
  const layoutEffects = [];
  const hooks = {
    useState(init) {
      const i = cursor++;
      if (cells.length <= i) cells[i] = { v: typeof init === 'function' ? init() : init };
      const cell = cells[i];
      return [cell.v, (next) => {
        const value = typeof next === 'function' ? next(cell.v) : next;
        if (!Object.is(value, cell.v)) { cell.v = value; dirty = true; }
      }];
    },
    useCallback: (fn) => fn,
    useEffect(fn, deps) { effects.push({ fn, deps }); },
    // 真 React 里 layout effect 与 passive effect 的差别是**时机**：前者在 DOM
    // 变更后、浏览器绘制前同步跑（用来量尺寸，避免先闪一下再跳），后者在绘制后
    // 异步跑。这个假实现里没有真正的绘制，唯一还成立、也唯一可能被依赖的语义是
    // **layout 先于 passive** —— 所以单独攒一队、在下面先跑，而不是直接
    // `useLayoutEffect: useEffect` 混进同一队。混了的话顺序取决于组件里的调用
    // 次序，测出来的东西就跟真实行为对不上了。
    useLayoutEffect(fn, deps) { layoutEffects.push({ fn, deps }); },
    useMemo: (fn) => fn(),
    useRef(init) {
      const i = cursor++;
      if (cells.length <= i) cells[i] = { v: { current: init } };
      return cells[i].v;
    },
    useSyncExternalStore: (_sub, get) => get(),
  };

  // 真 React 会继续往下渲染子组件；jsx() 只是造一个 `{type, props}` 描述对象，
  // 函数组件不会自己执行。面板的内容全在子组件里，不往下走就等于只测了最外面那层
  // 壳 —— 所以这里手动深渲染：遇到 type 是函数的节点就调它。
  const deepRender = (node, depth = 0) => {
    if (node === null || node === undefined || typeof node !== 'object' || depth > 60) return node;
    if (Array.isArray(node)) return node.map((child) => deepRender(child, depth + 1));
    // 换成组件的**输出**，而不是把输出塞回同一个节点的 children —— 后者的 type
    // 还是那个函数，下一轮又会命中这个分支，于是同一个组件被反复调用直到撞上深度
    // 上限，真正的子树一个节点都没进最终的树。组件函数体照样跑了，但树里只剩一层
    // 壳：行里的开关、按钮全都不在，也就没法触发它们的事件处理器。
    if (typeof node.type === 'function') return deepRender(node.type(node.props), depth + 1);
    const children = node.props && node.props.children;
    if (children === undefined) return node;
    return { ...node, props: { ...node.props, children: deepRender(children, depth + 1) } };
  };

  // 渲染到稳定：跑一遍组件（含子组件）→ 执行本轮攒下的 effect → 等微任务
  //（取数是 async）→ 状态变了就再来一轮。上限 12 轮，防止组件写成死循环时测试挂住。
  const render = async (renderOnce) => {
    const teardowns = [];
    let last;
    for (let round = 0; round < 12; round += 1) {
      cursor = 0;
      dirty = false;
      effects.length = 0;
      layoutEffects.length = 0;
      last = deepRender(renderOnce());
      // **别在这里调 teardown**。面板的每个取数 effect 都用 `let alive = true` +
      // teardown 里置 false 来防竞态，立刻 teardown 等于让所有 `.then` 直接 return，
      // 状态永远停在 loading —— 那正是这个测试最想避免的空壳。攒着，最后一起清。
      const seen = new Set();
      // layout 先于 passive，跟真 React 一致（见 useLayoutEffect 处的注释）。
      for (const { fn } of [...layoutEffects, ...effects]) {
        if (seen.has(fn)) continue;
        seen.add(fn);
        const teardown = fn();
        if (typeof teardown === 'function') teardowns.push(teardown);
      }
      await new Promise((r) => setTimeout(r, 0));
      if (!dirty) break;
    }
    for (const fn of teardowns) fn();
    return last;
  };

  return { jsxRuntime, hooks, render };
}

module.exports = { createFakeReact };
