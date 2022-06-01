const { Client } = require('@notionhq/client');
const { Tmdb } = require('tmdb');
const inquirer = require('inquirer');
const _ = require('lodash');

require('dotenv').config();

const genres = require('./genres.json');
const languages = {
  ch: 'Chinese',
  zh: 'Chinese',
  tl: 'Filipino',
  en: 'English',
  th: 'Thai',
  fr: 'French',
  id: 'Indonesian',
  hi: 'Indian',
  ko: 'Korean',
  vi: 'Vietnamese',
  it: 'Italian',
  ja: 'Japanese',
  es: 'Spanish',
};
const languageToFlag = {
  ch: '🇨🇳',
  zh: '🇨🇳',
  tl: '🇵🇭',
  en: '🇺🇸',
  th: '🇹🇭',
  fr: '🇫🇷',
  id: '🇮🇩',
  hi: '🇮🇳',
  ko: '🇰🇷',
  vi: '🇻🇳',
  it: '🇮🇹',
  ja: '🇯🇵',
  es: '🇪🇸',
}

const getFlagFromLanguage = (language) => {
  return language in languageToFlag ? languageToFlag[language] : '🏳️‍🌈';
};

const Notion = {
  URL: 'https://api.notion.com/v1',
  API_KEY: process.env.NOTION_API_KEY,
  MOVIE_DB: process.env.NOTION_MOVIE_DB,
};

const TheMovieDB = {
  URL: 'https://api.themoviedb.org/3',
  API_KEY: process.env.TMDB_API_KEY,
  IMAGE_API_URL: 'https://image.tmdb.org/t/p/w200',
};

const notion = new Client({ auth: Notion.API_KEY });
const tmdb = new Tmdb(TheMovieDB.API_KEY);

const SKIP_COLUMNS = [];

const getNotionMovies = async (pageSize = 100) => {
  const response = await notion.databases.query({
    database_id: Notion.MOVIE_DB,
    filter: {
      and: [
        // {
        //   property: 'Category',
        //   // multi_select: { is_empty: true },
        //   multi_select: { contains: 'Documentary' },
        // },
        // {
        //   property: 'Last Metadata Sync',
        //   date: { is_empty: true },
        // },
        {
          property: 'Type',
          select: { equals: 'Series' },
        },
        // {
        //   property: 'TMDB Link',
        //   url: { is_empty: true },
        // },
        {
          property: 'Title',
          title: { is_not_empty: true },
        },
      ],
    },
    page_size: pageSize,
  });

  // Format the rows into a better structure
  const movies = response.results.map((row) => {
    const { Title, Year, Type } = row.properties;

    return {
      id: row.id,
      title: Title.title[0].plain_text,
      year: Year.number,
      type: Type.select.name,
    };
  });

  return movies;
};

const getMovieMetadata = async ({ title: query, year = null, id: notionId, type }, updatedTitle) => {
  const isTv = type === 'Series';

  // Get the id of movie via search
  const movieParams = { query, year };
  const tvParams = { query, first_air_date_year: year };

  const path = isTv ? 'search/tv' : 'search/movie';
  const search = await tmdb.get(path, isTv ? tvParams : movieParams);

  if (!search.results.length) {
    const { newSearch } = await inquirer.prompt([{
      type: 'input',
      name: 'newSearch',
      prefix: '🛑 ',
      message: `No results found for ${query}${year ? ` (${year})` : ''}\nNew Search (enter to skip): `,
    }]);

    if (!newSearch) return undefined;

    const { newYear } = await inquirer.prompt([{
      type: 'input',
      name: 'newYear',
      prefix: '',
      message: 'New Year (optional): ',
    }]);
    console.log();

    return getMovieMetadata({ title: newSearch, year: newYear ? +newYear : undefined, id: notionId, type }, query);
  }

  let matchedResultId = search.results[0]?.id;

  if (search.results.length > 1) {
    const { chosenResult } = await inquirer.prompt([{
      type: 'list',
      name: 'chosenResult',
      prefix: '⚠️  ',
      message: `Multiple results found for ${query}${year ? ` (${year})` : ''}`,
      choices: [
        ...search.results.map(({ originalLanguage, genreIds, id: tmdbId, ...data }, index) => {
          const title = data.title || data.name;
          const releaseDate = data.releaseDate || data.firstAirDate;

          return {
            name: `${getFlagFromLanguage(originalLanguage)}   ${title} [${releaseDate}] - ${genreIds.map(id => genres[id]).join(', ')} (https://themoviedb.org/movie/${tmdbId})`,
            value: index,
          };
        }),
        { name: '⏩  Skip', value: 'skip' },
        { name: '🎬  Enter TMDB ID', value: 'enter-id' },
        ...(year ? [{ name: '🔎  Search without year', value: 'search' }] : []),
      ],
      pageSize: 20,
    }]);

    // Alternatives
    if (chosenResult === 'skip') return undefined;
    if (chosenResult === 'search') return getMovieMetadata({ title: query, id: notionId, type }, query);

    if (chosenResult === 'enter-id') {
      const { enteredId } = await inquirer.prompt([{
        type: 'input',
        name: 'enteredId',
        prefix: '🎬 ',
        message: 'Enter TMDB ID manually: ',
      }]);

      matchedResultId = enteredId;
    } else {
      matchedResultId = search.results[chosenResult]?.id;
    }
  }

  // Get Other Information
  const infoPath = isTv ? `tv/${matchedResultId}` : `movie/${matchedResultId}`;
  const movie = await tmdb.get(infoPath, {
    append_to_response: 'videos,credits',
  });

  const {
    genres: categories,
    id: tmdbId,
    originalLanguage,
    overview,
    posterPath,
  } = movie;

  const originalTitle = movie.originalTitle || movie.originalName;
  const title = movie.title || movie.name;
  const releaseDate = movie.releaseDate || movie.firstAirDate;

  const { crew } = movie.credits;
  const directors = isTv ? movie.createdBy : crew.filter(({ job }) => job === 'Director');

  const { results: videos } = movie.videos;
  const [defaultTrailer] = videos.filter(({ type }) => type === 'Trailer');
  const [teaser] = videos.filter(({ type }) => type === 'Teaser');
  const trailer = defaultTrailer || teaser || videos[0];

  return {
    id: tmdbId,
    notionId,
    categories: categories.map(({ name }) => name),
    originalTitle,
    title,
    synopsis: overview,
    year: (new Date(releaseDate)).getFullYear(),
    directors: directors.map(({ name }) => name),
    poster: posterPath,
    trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : undefined,
    language: originalLanguage && originalLanguage in languages ? languages[originalLanguage] : undefined,
    runtime: movie.runtime,
    updatedTitle,
  };
};

const useText = (content, type = 'rich_text') => ({
  [type]: [
    {
      type: 'text',
      text: { content },
    },
  ],
});

const updateNotionEntry = async (metadata, skipColumns = SKIP_COLUMNS) => {
  const { id, notionId, categories, originalTitle, title, synopsis, year, poster, directors, trailer, language, runtime, updatedTitle } = metadata;

  const SHORT_FILM_THRESHOLD = 30;

  const properties = {
    Title: updatedTitle ? useText(updatedTitle, 'title') : undefined,
    'Original Title': originalTitle === title ? useText(title) : useText(`${originalTitle} (${title})`),
    Synopsis: useText(synopsis),
    Year: { number: year },
    Category: {
      multi_select: categories.map(category => ({ name: category })),
    },
    Director: useText(directors.join('\n')),
    Poster: poster ? {
      files: [
        {
          type: 'external',
          name: title,
          external: {
            url: `${TheMovieDB.IMAGE_API_URL}${poster}`,
          },
        },
      ],
    } : undefined,
    'Last Metadata Sync': {
      date: { start: (new Date()).toISOString() },
    },
    Trailer: trailer ? { url: trailer } : undefined,
    Language: language ? {
      select: { name: language },
    } : undefined,
    Type: runtime ? {
      select: { name: runtime > SHORT_FILM_THRESHOLD ? 'Full-length' : 'Shorts' },
    } : undefined,
    'TMDB Link': { url: `https://themoviedb.org/movie/${id}` },
  };

  await notion.pages.update({
    page_id: notionId,
    properties: _.omit(properties, skipColumns),
  });

  const fullTitle = originalTitle !== title ? `${originalTitle} (${title})` : title;
  console.log(`    ✅  Updated ${fullTitle} [${year}]`);
};

async function main() {
  console.log('⏳  Fetching database from Notion');
  const movies = await getNotionMovies();

  console.log('🎬  Fetched the following movies:');
  console.log(movies.map(({ title }) => `    - ${title}`).join('\n'));
  console.log();

  const { notionConfirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'notionConfirm',
    message: 'Are you sure you want to continue?',
  }]);
  if (!notionConfirm) return;
  console.log();

  console.log('⏳  Fetching metadata from TMDB');
  const metadata = [];
  for (const movie of movies) {
    const data = await getMovieMetadata(movie);
    metadata.push(data);
  }
  console.log(metadata.filter(Boolean).map(
    (data) => `    🎥  ${data.title} (${data.originalTitle}) [${data.year}]`).join('\n'),
  );
  console.log();

  const { tmdbConfirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'tmdbConfirm',
    message: 'Are you sure you want to continue?',
  }]);
  if (!tmdbConfirm) return;
  console.log();

  console.log('⏳  Updating entries in Notion');
  await Promise.all(metadata.filter(Boolean).map(updateNotionEntry));
}

main();
