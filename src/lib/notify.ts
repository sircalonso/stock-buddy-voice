let swReg: ServiceWorkerRegistration | null = null;

export async function initNotifications(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "denied";
  if ("serviceWorker" in navigator) {
    try {
      swReg = await navigator.serviceWorker.register("/sw.js");
    } catch {
      swReg = null;
    }
  }
  return Notification.permission;
}

export async function askNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "denied";
  await initNotifications();
  if (Notification.permission === "default") return Notification.requestPermission();
  return Notification.permission;
}

export async function pushNotification(title: string, body: string, tag: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  const options: NotificationOptions = { body, tag, icon: "/favicon.ico", badge: "/favicon.ico" };
  try {
    const reg = swReg ?? (await navigator.serviceWorker?.ready);
    if (reg) {
      await reg.showNotification(title, options);
      return;
    }
  } catch {
    /* cae al aviso simple */
  }
  new Notification(title, options);
}
