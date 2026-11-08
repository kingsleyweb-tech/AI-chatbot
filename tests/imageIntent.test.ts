import { describe, expect, it } from 'vitest';
import { detectImageIntent, isGenerateRequest } from '../server/images/intent.js';
import { aspectFor } from '../server/config/images.js';

const none = { hasImageAttachment: false, previousImage: false };

describe('image intent: generation requests', () => {
  it.each([
    'Generate an image of a lion in a forest',
    'Create a realistic photograph of Accra at sunset',
    'Draw a futuristic city',
    'Make an illustration of a military aircraft',
    'Create a professional business logo',
    'Generate a 3D character',
    'Design a landscape wallpaper',
    'Create an image of a modern office',
    'Can you generate a picture of a red bicycle by the sea?',
    'please paint a bowl of fruit in the style of an oil painting',
    'I want a poster for a jazz night',
    'Sketch a cat sleeping on a sofa',
    'Render a 3D model of a coffee cup',
    'Could you make me a cartoon of a dancing goat',
    'give me a wallpaper of the northern lights',
  ])('"%s" is an image request', (text) => {
    expect(isGenerateRequest(text)).toBe(true);
    expect(detectImageIntent(text, none)?.kind).toBe('generate');
  });
});

describe('image intent: not image requests', () => {
  it.each([
    'Which AI model is best for generating images?',
    'What is the best tool to create a logo?',
    'How do I generate images with Stable Diffusion?',
    'How can I make my photos look more professional?',
    'Write a prompt for an image of a lion',
    'Create a name for my logo',
    'Generate a catchy slogan for my bakery poster',
    'Draw a conclusion from these results',
    'Can you draw a comparison between Python and Go?',
    'Describe a picture of a sunset',
    'Explain how image generation models work',
    'Is it possible to create images here?',
    'Create a React component that renders an image gallery',
    'Write code to generate a thumbnail from a photo',
    'Create a list of ideas for a wallpaper app',
    'What does this logo mean?',
    'Tell me about the history of painting',
    'Make a plan for my photography business',
    'hello',
    'Summarize this document',
  ])('"%s" is not an image request', (text) => {
    expect(detectImageIntent(text, none)).toBeNull();
  });
});

describe('image intent: editing', () => {
  it('edits an attached picture when asked to change it', () => {
    expect(detectImageIntent('Remove the background', { hasImageAttachment: true, previousImage: false })).toEqual({
      kind: 'edit',
      prompt: 'Remove the background',
      source: 'attachment',
    });
    expect(detectImageIntent('Make this photo black and white', { hasImageAttachment: true, previousImage: false })?.kind).toBe('edit');
  });
  it('does not edit when the user asks about the attached picture', () => {
    expect(detectImageIntent('What is in this image?', { hasImageAttachment: true, previousImage: false })).toBeNull();
    expect(detectImageIntent('Describe this photo', { hasImageAttachment: true, previousImage: false })).toBeNull();
    expect(detectImageIntent('Write a caption for this photo', { hasImageAttachment: true, previousImage: false })).toBeNull();
  });
  it('edits the previous generated image on a follow-up', () => {
    const prev = { hasImageAttachment: false, previousImage: true };
    expect(detectImageIntent('make it more realistic', prev)).toEqual({ kind: 'edit', prompt: 'make it more realistic', source: 'previous' });
    expect(detectImageIntent('Now change the background to blue', prev)?.kind).toBe('edit');
    expect(detectImageIntent('turn it into a watercolor', prev)?.kind).toBe('edit');
    // a fresh request after an image is a new image, not an edit
    expect(detectImageIntent('Generate an image of a whale', prev)?.kind).toBe('generate');
  });
  it('treats follow-up text requests and questions as chat', () => {
    const prev = { hasImageAttachment: false, previousImage: true };
    expect(detectImageIntent('why is it red?', prev)).toBeNull();
    expect(detectImageIntent('make your answer shorter', prev)).toBeNull();
    expect(detectImageIntent('thanks!', prev)).toBeNull();
    // without a previous image, "make it ..." is ordinary chat
    expect(detectImageIntent('make it more realistic', none)).toBeNull();
  });
});

describe('aspect ratio from the request', () => {
  it('picks a shape that matches the wording', () => {
    expect(aspectFor('Design a landscape wallpaper')).toBe('landscape');
    expect(aspectFor('Create a professional business logo')).toBe('square');
    expect(aspectFor('a phone wallpaper of a forest')).toBe('portrait');
    expect(aspectFor('a poster for a jazz night')).toBe('portrait');
    expect(aspectFor('a 16:9 banner for my channel')).toBe('landscape');
  });
});
