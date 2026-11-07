import { useEffect, useState } from 'react';
import { getConnectionStatus, onConnectionStatusChange } from '../services/socket';

/** The socket's connection status, live. */
export function useConnectionStatus(): ReturnType<typeof getConnectionStatus> {
  const [connection, setConnection] = useState(getConnectionStatus);
  useEffect(() => onConnectionStatusChange(setConnection), []);
  return connection;
}
