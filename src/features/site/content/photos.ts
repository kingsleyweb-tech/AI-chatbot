/**
 * Photographs used on the public website. All are from Unsplash and free to
 * use under the Unsplash License (https://unsplash.com/license); the
 * photographer is credited next to each image anyway. Files are WebP, cropped
 * to 3:2 and stored at two widths in public/photos (<name>-800.webp and
 * <name>-1600.webp).
 */

export interface Photo {
  /** base path without the width suffix, e.g. /photos/voice */
  src: string;
  alt: string;
  credit: string;
  /** the photo's page on Unsplash */
  creditUrl: string;
}

export const PHOTOS = {
  /** homepage hero backdrop, stored pre-blurred as hero-backdrop-<w>.webp */
  heroBackdrop: {
    src: '/photos/hero-backdrop',
    alt: '',
    credit: 'Dennis Zhang',
    creditUrl: 'https://unsplash.com/photos/a-winding-river-flows-through-a-lush-green-valley-S7M9k4d18UQ',
  },
  research: {
    src: '/photos/research',
    alt: 'A laptop screen showing a data analysis chart',
    credit: 'Hasnain Ayaz',
    creditUrl: 'https://unsplash.com/photos/a-laptop-displays-data-analysis-on-its-screen-K_00pB2WT9Y',
  },
  documents: {
    src: '/photos/documents',
    alt: 'Stacks of paper documents and file folders',
    credit: 'Wesley Tingey',
    creditUrl: 'https://unsplash.com/photos/stacks-of-paper-documents-and-file-folders-snNHKZ-mGfE',
  },
  images: {
    src: '/photos/images',
    alt: 'A photographer framing a shot with a DSLR camera',
    credit: 'Jakob Owens',
    creditUrl: 'https://unsplash.com/photos/shallow-focus-photography-of-man-using-a-dslr-camera-DQPP9rVLYGQ',
  },
  voice: {
    src: '/photos/voice',
    alt: 'A studio microphone in front of a computer monitor',
    credit: 'Koen Sweers',
    creditUrl: 'https://unsplash.com/photos/a-microphone-in-front-of-a-computer-monitor-O6B3_2ylHLo',
  },
  translate: {
    src: '/photos/translate',
    alt: 'A busy street full of people in Accra, Ghana',
    credit: 'Ato Aikins',
    creditUrl: 'https://unsplash.com/photos/a-red-truck-parked-next-to-a-street-filled-with-people-6xc1KdasGYk',
  },
  blogSources: {
    src: '/photos/blog-sources',
    alt: 'A person reading a newspaper next to a laptop and a cup of coffee',
    credit: 'Anna Keibalo',
    creditUrl: 'https://unsplash.com/photos/a-person-reading-a-newspaper-next-to-a-laptop-1RVduxIDdY4',
  },
  blogResearch: {
    src: '/photos/blog-research',
    alt: 'A desk at night with an open book, a laptop and handwritten research notes',
    credit: 'Yen Vu',
    creditUrl: 'https://unsplash.com/photos/desk-with-open-book-laptop-and-study-materials-HNjWq8WPyoY',
  },
  blogVoice: {
    src: '/photos/blog-voice',
    alt: 'A podcast microphone in a recording studio',
    credit: 'dlxmedia.hu',
    creditUrl: 'https://unsplash.com/photos/a-close-up-of-a-microphone-with-a-light-in-the-background-mWghYOJ8i1I',
  },
} satisfies Record<string, Photo>;
