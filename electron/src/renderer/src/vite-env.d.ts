/// <reference types="vite/client" />
import type { ManagerApi } from '../../shared/contracts'
declare global { interface Window { manager: ManagerApi } }
