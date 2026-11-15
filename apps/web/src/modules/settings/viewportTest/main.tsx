import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '../../../index.css'
import './viewportTest.css'
import { ViewportTest } from './ViewportTest'

createRoot(document.getElementById('root')!).render(<ViewportTest />)
