import React from 'react';
import { createPortal } from 'react-dom';

interface Props {
  children: React.ReactNode;
}

// 保活的 Session Tab 不会卸载子组件；Portal 也必须跟随所属视图隐藏。
export const AppModalVisibilityContext = React.createContext(true);

/**
 * 把应用级浮层移出侧栏/分栏的 transform + overflow 裁剪上下文。
 * 目标保持在 .app-root 内，因此仍会继承当前主题 CSS 变量。
 */
export const AppModalPortal: React.FC<Props> = ({ children }) => {
  const visible = React.useContext(AppModalVisibilityContext);
  if (typeof document === 'undefined') return null;
  const target = document.querySelector<HTMLElement>('.app-root') || document.body;
  return createPortal(<div hidden={!visible} style={{ display: visible ? 'contents' : 'none' }}>{children}</div>, target);
};
