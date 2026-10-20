// Bundled local comparison corpus.
//
// Everything in this file is public domain and reproduced only in short
// excerpts for deterministic local matching. The corpus is intentionally small:
// it proves the matching pipeline without implying internet-wide, academic
// database, or cross-platform plagiarism detection.
//
// To use a larger legally permitted corpus, replace this module's sources with
// an explicitly licensed dataset. Never add other students' private submissions
// to a shared corpus, and never copy content without a documented legal basis.

export interface LocalCorpusSource {
  id: string;
  title: string;
  author: string;
  url: string;
  license: string;
  /** Optional guard: a source document id that must never match itself. */
  documentId?: string;
  text: string;
}

const GUTENBERG = "https://www.gutenberg.org";

export const LOCAL_CORPUS_ID = "public-domain-v1";

export const LOCAL_CORPUS_SOURCES: readonly LocalCorpusSource[] = [
  {
    id: "gutenberg:pride-and-prejudice",
    title: "Pride and Prejudice",
    author: "Jane Austen",
    url: `${GUTENBERG}/ebooks/1342`,
    license: "Public domain (Project Gutenberg eBook #1342)",
    text: `It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.

However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered as the rightful property of some one or other of their daughters.

"My dear Mr. Bennet," said his lady to him one day, "have you heard that Netherfield Park is let at last?"

Mr. Bennet replied that he had not.

"But it is," returned she; "for Mrs. Long has just been here, and she told me all about it."

Mr. Bennet made no answer.`,
  },
  {
    id: "gutenberg:moby-dick",
    title: "Moby-Dick; or, The Whale",
    author: "Herman Melville",
    url: `${GUTENBERG}/ebooks/2701`,
    license: "Public domain (Project Gutenberg eBook #2701)",
    text: `Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world.

It is a way I have of driving off the spleen and regulating the circulation. Whenever I find myself growing grim about the mouth; whenever it is a damp, drizzly November in my soul; whenever I find myself involuntarily pausing before coffin warehouses, and bringing up the rear of every funeral I meet; and especially whenever my hypos get such an upper hand of me, that it requires a strong moral principle to prevent me from deliberately stepping into the street, and methodically knocking people's hats off—then, I account it high time to get to sea as soon as I can.`,
  },
  {
    id: "gutenberg:sherlock-holmes",
    title: "The Adventures of Sherlock Holmes",
    author: "Arthur Conan Doyle",
    url: `${GUTENBERG}/ebooks/1661`,
    license: "Public domain (Project Gutenberg eBook #1661)",
    text: `To Sherlock Holmes she is always the woman. I have seldom heard him mention her under any other name. In his eyes she eclipses and predominates the whole of her sex.

It was not that he felt any emotion akin to love for Irene Adler. All emotions, and that one particularly, were abhorrent to his cold, precise but admirably balanced mind. He was, I take it, the most perfect reasoning and observing machine that the world has seen, but as a lover he would have placed himself in a false position.

He never spoke of the softer passions, save with a gibe and a sneer. They were admirable things for the observer—excellent for drawing the veil from men's motives and actions. But for the trained reasoner to admit such intrusions into his own delicate and finely adjusted temperament was to introduce a distracting factor which might throw a doubt upon all his mental results.`,
  },
  {
    id: "gutenberg:frankenstein",
    title: "Frankenstein; or, The Modern Prometheus",
    author: "Mary Wollstonecraft Shelley",
    url: `${GUTENBERG}/ebooks/84`,
    license: "Public domain (Project Gutenberg eBook #84)",
    text: `You will rejoice to hear that no disaster has accompanied the commencement of an enterprise which you have regarded with such evil forebodings. I arrived here yesterday, and my first task is to assure my dear sister of my welfare and increasing confidence in the success of my undertaking.

I am already far north of London, and as I walk in the streets of Petersburgh, I feel a cold northern breeze play upon my cheeks, which braces my nerves and fills me with delight. Do you understand this feeling? This breeze, which has travelled from the regions towards which I am advancing, gives me a foretaste of those icy climes.`,
  },
  {
    id: "gutenberg:declaration-of-independence",
    title: "The Declaration of Independence of the United States of America",
    author: "Thomas Jefferson et al.",
    url: `${GUTENBERG}/ebooks/1`,
    license: "Public domain (Project Gutenberg eBook #1)",
    text: `When in the Course of human events, it becomes necessary for one people to dissolve the political bands which have connected them with another, and to assume among the powers of the earth, the separate and equal station to which the Laws of Nature and of Nature's God entitle them, a decent respect to the opinions of mankind requires that they should declare the causes which impel them to the separation.

We hold these truths to be self-evident, that all men are created equal, that they are endowed by their Creator with certain unalienable Rights, that among these are Life, Liberty and the pursuit of Happiness.`,
  },
  {
    id: "gutenberg:the-raven",
    title: "The Raven",
    author: "Edgar Allan Poe",
    url: `${GUTENBERG}/ebooks/1065`,
    license: "Public domain (Project Gutenberg eBook #1065)",
    text: `Once upon a midnight dreary, while I pondered, weak and weary,
Over many a quaint and curious volume of forgotten lore—
While I nodded, nearly napping, suddenly there came a tapping,
As of some one gently rapping, rapping at my chamber door.
"'Tis some visitor," I muttered, "tapping at my chamber door—
Only this and nothing more."

Ah, distinctly I remember it was in the bleak December;
And each separate dying ember wrought its ghost upon the floor.
Eagerly I wished the morrow;—vainly I had sought to borrow
From my books surcease of sorrow—sorrow for the lost Lenore—
For the rare and radiant maiden whom the angels name Lenore—
Nameless here for evermore.`,
  },
  {
    id: "gutenberg:the-great-gatsby",
    title: "The Great Gatsby",
    author: "F. Scott Fitzgerald",
    url: `${GUTENBERG}/ebooks/64317`,
    license: "Public domain in the United States (Project Gutenberg eBook #64317)",
    text: `In my younger and more vulnerable years my father gave me some advice that I've been turning over in my mind ever since.

"Whenever you feel like criticizing any one," he told me, "just remember that all the people in this world haven't had the advantages that you've had."

He didn't say any more, but we've always been unusually communicative in a reserved way, and I understood that he meant a great deal more than that. In consequence, I'm inclined to reserve all judgments, a habit that has opened up many curious natures to me and also made me the victim of not a few veteran bores.`,
  },
] as const;
