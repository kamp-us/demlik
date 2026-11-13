export type ForListingBooks = () => Promise<string[]>;
export type ForSavingBooks = (title: string) => Promise<void>;
export type ForListingFilms = () => Promise<string[]>;
export type ForSavingFilms = (title: string) => Promise<void>;

type Listings = { list: ForListingBooks };
export type Books = Listings & { shelve: ForSavingBooks };
export type BooksDriven = { save: ForSavingBooks };
export type Films = { screen: ForListingFilms };
export type FilmsDriven = { archive: ForSavingFilms };
