import type { EmojiCatalogPayload } from './catalog';

export const fixture: EmojiCatalogPayload = {
  version: '17.0.0',
  en: [
    {
      hexcode: '1F604',
      unicode: '😄',
      label: 'grinning face with smiling eyes',
      group: 0,
      order: 3,
      tags: ['happy', 'smile'],
    },
    { hexcode: '2764', unicode: '❤️', label: 'red heart', group: 0, order: 10, tags: ['love'] },
    {
      hexcode: '1F431',
      unicode: '🐱',
      label: 'cat face',
      group: 3,
      order: 20,
      tags: ['animal', 'pet'],
    },
  ],
  zh: [
    { hexcode: '1F604', unicode: '😄', label: '大笑', tags: ['开心', '高兴'] },
    { hexcode: '2764', unicode: '❤️', label: '红心', tags: ['爱'] },
    { hexcode: '1F431', unicode: '🐱', label: '猫脸', tags: ['宠物'] },
  ],
  shortcodes: { '1F604': 'smile', '2764': ['heart', 'red_heart'], '1F431': 'cat' },
};
