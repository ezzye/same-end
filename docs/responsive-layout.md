# Responsive home and room layout

The picture, room shortcuts, invitation actions, sound controls and room status form one `.room-picture-column`. When chat is available, `moveChat()` places that column beside the chat shell. Older minimal integrations without this wrapper still move the stage alone. IDs, listeners, video/audio nodes and room lifecycle remain unchanged.

In a normal page, waiting content contributes its natural height rather than scrolling behind a fixed video crop. The actual video remains connected and absolutely positioned beneath the waiting panel. At desktop widths the welcome graphic sits alongside its text/audio controls; on phones it stacks. Expanded reading/transcript content grows the page. Guide playback, network limits and readiness logic are unchanged.

Desktop chat follows the picture column's height where size containment is supported and otherwise uses a bounded-height fallback. Phone pages use normal document flow: picture/guide, nearby controls, then chat. Full room uses viewport-height bounds, a readable message area and scrollable picture/control column when space is tight. The waiting heading does not cover audio controls when scrolling. Ordinary status messages remain present; only the repeated room-sound hint is suppressed in phone full-room mode.

Join-only phones/tablets receive a presentation class from the existing hosting policy. Their unsupported sharing card is omitted without changing capture permissions or private-room creation/joining. The Bring your mates section and inline forum remain available.

Validation: `npm run test:layout` uses the real built app and isolated local room API with three long chat messages. It covers guest/open sections and 320/390/430/768/1280/1796 widths, waiting/stopped/picture state fixtures, expanded guide content, short-phone and landscape full-room bounds, audio/exit reachability, and a mobile capability context. `--baseline` captures the saved pre-change full build for comparison. Screenshots contain generated local test content, not live media or real users. This browser layout evidence does not certify physical-device playback.
