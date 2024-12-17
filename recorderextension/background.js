const URL_TO_OPEN = "https://lessontime.ai/recorder"; // Replace with your desired URL

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({ url: URL_TO_OPEN });
});