import type { Node as PmNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import { onInterfaceLocaleChanged, t } from '../../../app/i18n';
import { detailsIsOpen, setDetailsTemporaryOpen } from '../details/detailsState';
import { setDetailsDefaultOpen, unwrapDetails } from '../details/detailsCommands';

export class DetailsNodeView implements NodeView {
  dom = document.createElement('div');
  contentDOM = this.dom;
  constructor(private node: PmNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom.className = 'details-block';
  }
  update(node: PmNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    const pos = this.getPos();
    if (pos !== undefined) {
      const open = detailsIsOpen(this.view.state, pos);
      this.dom.querySelector(':scope > .details-summary > .details-toggle')?.setAttribute('aria-expanded', String(open));
      this.dom.querySelector(':scope > .details-summary .details-default-open')?.setAttribute('aria-checked', String(node.attrs.defaultOpen));
    }
    return true;
  }
  ignoreMutation(mutation: ViewMutationRecord): boolean { return mutation.type === 'attributes' && mutation.target === this.dom; }
}

interface DetailsEditing { awaitCompositionEnd(): Promise<void>; commitPendingEdits(): void }

/** 标题是主文档中的文本节点；控件不使用独立输入框或第二套撤销栈。 */
export class DetailsSummaryNodeView implements NodeView {
  dom = document.createElement('div');
  contentDOM = document.createElement('span');
  private toggle = document.createElement('button');
  private more = document.createElement('button');
  private menu = document.createElement('span');
  private defaultOpen = document.createElement('button');
  private unwrap = document.createElement('button');
  private disposed = false;
  private actionVersion = 0;
  private unsubscribe: () => void;

  constructor(private node: PmNode, private view: EditorView, private getPos: () => number | undefined,
    private editing: DetailsEditing) {
    this.dom.className = 'details-summary';
    this.contentDOM.className = 'details-summary-content';
    this.toggle.className = 'details-toggle';
    this.toggle.textContent = '▸';
    this.more.className = 'details-more';
    this.more.textContent = '⋯';
    this.more.setAttribute('aria-haspopup', 'menu');
    this.more.setAttribute('aria-expanded', 'false');
    this.menu.className = 'details-menu';
    this.menu.hidden = true;
    this.menu.contentEditable = 'false';
    this.menu.setAttribute('role', 'menu');
    this.defaultOpen.className = 'details-default-open';
    this.defaultOpen.setAttribute('role', 'menuitemcheckbox');
    this.unwrap.setAttribute('role', 'menuitem');
    for (const button of [this.toggle, this.more, this.defaultOpen, this.unwrap]) {
      button.type = 'button';
      button.contentEditable = 'false';
      button.addEventListener('mousedown', this.keepSelection);
    }
    this.toggle.addEventListener('click', this.toggleOpen);
    this.more.addEventListener('click', this.toggleMenu);
    this.defaultOpen.addEventListener('click', this.changeDefault);
    this.unwrap.addEventListener('click', this.removeWrapper);
    this.dom.addEventListener('keydown', this.onKeyDown);
    this.dom.addEventListener('focusout', this.onFocusOut);
    this.menu.append(this.defaultOpen, this.unwrap);
    this.dom.append(this.toggle, this.contentDOM, this.more, this.menu);
    this.unsubscribe = onInterfaceLocaleChanged(() => this.refresh());
    this.refresh();
  }
  private keepSelection = (event: MouseEvent) => event.preventDefault();
  private refresh = () => {
    const pos = this.getPos();
    const parent = pos === undefined ? null : this.view.state.doc.nodeAt(pos - 1);
    this.toggle.setAttribute('aria-label', t.detailsToggle());
    this.toggle.setAttribute('aria-expanded', String(pos !== undefined && detailsIsOpen(this.view.state, pos - 1)));
    this.contentDOM.dataset.placeholder = t.detailsTitlePlaceholder();
    this.more.setAttribute('aria-label', t.detailsOptions());
    this.more.hidden = !this.view.editable;
    this.defaultOpen.textContent = t.detailsDefaultOpen();
    this.defaultOpen.setAttribute('aria-checked', String(parent?.attrs.defaultOpen ?? false));
    this.unwrap.textContent = t.unwrapDetails();
  };
  private closeMenu = () => { this.menu.hidden = true; this.more.setAttribute('aria-expanded', 'false'); };
  private toggleMenu = () => {
    if (!this.view.editable) return;
    this.refresh();
    this.menu.hidden = !this.menu.hidden;
    this.more.setAttribute('aria-expanded', String(!this.menu.hidden));
    if (!this.menu.hidden) this.defaultOpen.focus();
  };
  private onFocusOut = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node) || !this.dom.contains(event.relatedTarget)) this.closeMenu();
  };
  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !this.menu.hidden) { event.preventDefault(); this.closeMenu(); this.more.focus(); }
    if (!this.menu.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      (event.target === this.defaultOpen ? this.unwrap : this.defaultOpen).focus();
    }
  };
  private async withCommittedContent(action: (pos: number) => void): Promise<void> {
    const version = ++this.actionVersion;
    await this.editing.awaitCompositionEnd();
    if (this.disposed || this.view.isDestroyed || version !== this.actionVersion) return;
    this.editing.commitPendingEdits();
    const summaryPos = this.getPos();
    if (summaryPos === undefined || this.view.state.doc.nodeAt(summaryPos - 1)?.type.name !== 'details') return;
    action(summaryPos - 1);
    this.refresh();
  }
  private toggleOpen = () => { void this.withCommittedContent(pos => {
    const { state } = this.view;
    const open = !detailsIsOpen(state, pos);
    const tr = state.tr;
    const node = state.doc.nodeAt(pos)!;
    if (!open && [state.selection.anchor, state.selection.head].some(position =>
      position > pos + node.firstChild!.nodeSize && position < pos + node.nodeSize)) {
      tr.setSelection(TextSelection.create(state.doc, pos + 2));
    }
    this.view.dispatch(setDetailsTemporaryOpen(tr, pos, open));
    if (this.view.editable) this.view.focus();
  }); };
  private changeDefault = () => { void this.withCommittedContent(pos => {
    if (!this.view.editable) return;
    setDetailsDefaultOpen(!this.view.state.doc.nodeAt(pos)!.attrs.defaultOpen, pos)(this.view.state, this.view.dispatch);
    this.closeMenu(); this.view.focus();
  }); };
  private removeWrapper = () => { void this.withCommittedContent(pos => {
    if (!this.view.editable) return;
    unwrapDetails(pos)(this.view.state, this.view.dispatch);
    this.closeMenu(); this.view.focus();
  }); };
  update(node: PmNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node; this.refresh(); return true;
  }
  stopEvent(event: Event): boolean { return event.target instanceof Node && !this.contentDOM.contains(event.target); }
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.type !== 'selection' && (mutation.target === this.dom || mutation.target === this.contentDOM && mutation.type === 'attributes' || !this.contentDOM.contains(mutation.target));
  }
  destroy(): void {
    this.disposed = true; this.actionVersion++;
    this.unsubscribe();
    this.toggle.removeEventListener('click', this.toggleOpen);
    this.more.removeEventListener('click', this.toggleMenu);
    this.defaultOpen.removeEventListener('click', this.changeDefault);
    this.unwrap.removeEventListener('click', this.removeWrapper);
    this.dom.removeEventListener('keydown', this.onKeyDown);
    this.dom.removeEventListener('focusout', this.onFocusOut);
    for (const button of [this.toggle, this.more, this.defaultOpen, this.unwrap]) button.removeEventListener('mousedown', this.keepSelection);
  }
}
