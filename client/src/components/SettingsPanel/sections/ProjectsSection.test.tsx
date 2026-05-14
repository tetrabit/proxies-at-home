import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/ProjectSelector', () => ({
  ProjectSelector: () => <div data-testid="project-selector">Project selector</div>,
}));

vi.mock('@/components/common', () => ({
  AutoTooltip: ({ children, content }: { children: React.ReactNode; content: string }) => <span data-tooltip={content}>{children}</span>,
}));

vi.mock('flowbite-react', () => ({
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
}));

import { ProjectsSection } from './ProjectsSection';

describe('ProjectsSection', () => {
  it('renders the project selector with explanatory tooltip', () => {
    const { container } = render(<ProjectsSection />);
    expect(screen.getByText('Current Project')).toBeDefined();
    expect(screen.getByTestId('project-selector')).toBeDefined();
    expect(container.querySelector('[data-tooltip="Switch between different decks/projects. Each project has its own cards and settings."]')).toBeTruthy();
  });
});
