// T05 · 组件级单测（mock / 非真实联调）：纯展示/交互组件，无后端、无数据库
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Badge, Button, Modal } from './ui';

describe('Badge', () => {
  it('默认 tone 为 gray，并按 tone 生成 badge-<tone> 类名', () => {
    const { container, rerender } = render(<Badge>默认</Badge>);
    expect(container.querySelector('span')?.className).toContain('badge-gray');
    rerender(<Badge tone="green">完成</Badge>);
    expect(container.querySelector('span')?.className).toContain('badge-green');
    expect(container.querySelector('span')?.textContent).toBe('完成');
  });
});

describe('Button', () => {
  it('variant / size 生成对应 btn-* 类名', () => {
    const { container } = render(
      <Button variant="primary" size="sm">
        保存
      </Button>,
    );
    const cls = container.querySelector('button')?.className ?? '';
    expect(cls).toContain('btn');
    expect(cls).toContain('btn-primary');
    expect(cls).toContain('btn-sm');
  });

  it('disabled 属性透传且 variant 生效', () => {
    render(
      <Button disabled variant="danger">
        禁用
      </Button>,
    );
    const btn = screen.getByRole('button', { name: '禁用' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.className).toContain('btn-danger');
  });
});

describe('Modal', () => {
  it('open=false 不渲染；open=true 渲染标题、正文与关闭按钮', () => {
    const { container, rerender } = render(
      <Modal open={false} title="标题" onClose={() => {}}>
        内容
      </Modal>,
    );
    expect(container.querySelector('.modal-overlay')).toBeNull();
    rerender(
      <Modal open title="标题" onClose={() => {}}>
        内容
      </Modal>,
    );
    expect(screen.getByText('标题')).toBeTruthy();
    expect(screen.getByText('内容')).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();
  });

  it('点击关闭按钮与按下 Escape 都会触发 onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal open title="标题" onClose={onClose}>
        内容
      </Modal>,
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
