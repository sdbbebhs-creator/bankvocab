# Vercel + Supabase setup

This project has been switched from the deleted Supabase project to the new Supabase project.

## Supabase

Project URL:
`https://synchbngrabzbngwzqwq.supabase.co`

The database migration creates:
- `vocab_items`
- `grammar_items`
- `study_data`

The app stores card content and FSRS data directly in those Supabase tables. Row Level Security is enabled.

## Vercel environment variables

Add these to the Vercel project for Production, Preview, and Development as needed:

- `VITE_SUPABASE_URL` = `https://synchbngrabzbngwzqwq.supabase.co`
- `VITE_SUPABASE_ANON_KEY` = the Supabase publishable key
- `GEMINI_API_KEY` = your Gemini API key (needed for AI features)

Do not put a Supabase service-role/secret key in the frontend environment.

## Important

The card data and FSRS synchronization no longer depend on Netlify DB or `/api/sync`; they use Supabase directly, so the main data flow works on Vercel.

AI endpoints were also copied to `api/ai/` for Vercel:
- `/api/ai/context-practice`
- `/api/ai/lookup-item`
- `/api/ai/optimize-fsrs`

The old `netlify/` files are retained only as legacy files and are not required by the Vercel frontend.
