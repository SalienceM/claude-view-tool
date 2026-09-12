/** 只压缩应用控件的留白，不缩放文字、预览文档、画布或用户内容。 */
export const uiDensityCss = `
  /* 手机/窄屏和触屏维持原有可点击尺寸；桌面鼠标工作区采用 IDE 式密度。 */
  @media (min-width: 769px) and (pointer: fine) {
    .app-root {
      --ui-space-sm: 6px;
      --ui-space-md: 8px;
      --ui-space-lg: 12px;
      --ui-space-xl: 16px;
      --ui-control-height: 26px;
      --ui-activity-width: 40px;
      --ui-activity-height: 40px;
      --ui-header-height: 36px;
      --ui-header-padding: 3px 10px;
      --ui-tab-height: 30px;
      --ui-tab-padding: 4px 8px;
      --ui-tab-close-width: 28px;
      --ui-session-height: 28px;
      --ui-session-padding: 3px 6px;
      --ui-group-height: 32px;
      --ui-search-height: 28px;
      --ui-message-padding: 8px 10px;
      --ui-message-gutter: 12px;
      --ui-composer-padding: 6px 12px 8px;
      --ui-send-size: 32px;
      --ui-home-padding: 16px 20px 24px;
      --ui-sidebar-header-padding: 6px 8px 4px;
      --ui-panel-header-height: 44px;
      --ui-section-padding: 10px;
      --ui-settings-content-padding: 12px 16px 16px;
      --ui-field-padding: 6px 8px;
      --ui-kit-card-height: 210px;
      --ui-loop-body-padding: 8px 12px 16px;
      --ui-loop-header-padding: 8px 12px;
      --ui-loop-rail-padding: 6px 12px;
    }
  }
`;
