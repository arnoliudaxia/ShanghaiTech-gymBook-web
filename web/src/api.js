export const fetchSnapshot = () =>
  fetch('/api/availability').then((res) => res.json())
