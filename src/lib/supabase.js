import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://tapebvyncdpnezlhsnpy.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRhcGVidnluY2RwbmV6bGhzbnB5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyODUxNTQsImV4cCI6MjA5Mjg2MTE1NH0.OJaA14BIE3c9tlUe97Mse6oqt9M8oqLMSfoxLzfiGtw'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
