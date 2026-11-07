// Any other website. Gol uses this for pages it has no definition for: the
// MeoDeo server checked the page and found its own embeddable player, a
// plain video file, or a video that can only be watched on the site itself.
export default {
  id: "web",
  name: "Web",
  domain: "web",
  color: "#5d6573",
  ads: false,
  generic: true,
  embedHosts: ["*"],
  sandboxed: true, // unknown players run in a sandboxed iframe
};
