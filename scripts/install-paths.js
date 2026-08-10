// Ce module trouve les trois dossiers ou le device doit atterrir. Il existe parce que les deviner
// ne marche pas : la premiere version de l'installateur ecrivait dans
// `%USERPROFILE%\Documents\Max 8\Library`, et rien de ce qu'elle posait n'etait jamais lu.
//
// Deux erreurs se cumulaient, chacune suffisante a rendre le device muet :
//
//   1. `Documents` n'est pas toujours sous `%USERPROFILE%`. Quand OneDrive reprend le dossier, le
//      vrai `Documents` devient `%USERPROFILE%\OneDrive\Documents`, et `%USERPROFILE%\Documents`
//      reste un dossier vide que rien ne lit. Seul le registre dit lequel des deux compte.
//
//   2. La version de Max n'est pas celle du dossier `Max 8`. Live 12.4 embarque Max 9, qui indexe
//      `Documents\Max 9\Library` et ignore `Max 8`. La version doit etre lue dans le Max livre
//      avec Ableton, pas ecrite en dur.
//
// Les chemins sont donc tous deduits de l'etat reel de la machine : le registre pour `Documents`,
// et l'executable de Max livre avec chaque Ableton installe pour sa version.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DOCUMENTS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer";

// Cette fonction lit une valeur du registre, ou rend une chaine vide si elle n'existe pas.
// Une machine sans cette valeur ne doit pas faire echouer l'installation : les autres pistes
// prennent la suite.
function registryValue(subKey, name) {
	try {
		const output = execFileSync("reg", ["query", `${DOCUMENTS_KEY}\\${subKey}`, "/v", name], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const match = output.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
		return match === null ? "" : match[1].trim();
	} catch {
		return "";
	}
}

// Cette fonction remplace les `%NOM%` d'un chemin par les variables d'environnement.
// `User Shell Folders` stocke ses chemins sous cette forme.
function expandEnvironment(text) {
	return text.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole);
}

// Cette fonction rend le vrai dossier `Documents` du compte.
//
// L'ordre des pistes va de la plus fiable a la plus generale. `Shell Folders` porte le chemin deja
// resolu, `User Shell Folders` le porte avec ses variables, et les deux dernieres pistes ne servent
// qu'a une machine dont le registre ne repond pas.
export function documentsFolder() {
	const candidates = [
		registryValue("Shell Folders", "Personal"),
		expandEnvironment(registryValue("User Shell Folders", "Personal")),
		process.env.OneDrive === undefined ? "" : join(process.env.OneDrive, "Documents"),
		process.env.USERPROFILE === undefined ? "" : join(process.env.USERPROFILE, "Documents"),
	];

	for (const candidate of candidates) {
		if (candidate !== "" && existsSync(candidate)) {
			return candidate;
		}
	}

	// Aucun candidat n'existe : le dernier reste le moins surprenant, et sera cree.
	return join(process.env.USERPROFILE ?? "", "Documents");
}

// Cette fonction lit la version d'un executable Windows. Elle sert a departager les Ableton
// installes, et surtout a connaitre la version du Max que chacun embarque.
function fileVersion(file) {
	try {
		// Le chemin part entre apostrophes : PowerShell y prend le texte au pied de la lettre, alors
		// qu'entre guillemets il verrait un `$` comme une variable. Une apostrophe dans le chemin se
		// double, c'est la seule sequence a echapper dans cette forme.
		const quoted = `'${file.replace(/'/g, "''")}'`;
		const command = `(Get-Item -LiteralPath ${quoted}).VersionInfo.ProductVersion`;
		return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
}

// Cette fonction transforme une version en liste de nombres comparables. `12.4.5b4` devient
// `[12, 4, 5, 4]` : la beta se classe apres la version publiee du meme numero, ce qui est bien
// l'ordre des sorties d'Ableton.
function versionOrder(version) {
	return version
		.split(/[.b]/)
		.map((part) => Number.parseInt(part, 10))
		.map((number) => (Number.isNaN(number) ? 0 : number));
}

// Cette fonction compare deux versions, la plus recente d'abord.
function byVersionDescending(left, right) {
	const a = versionOrder(left.version);
	const b = versionOrder(right.version);

	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const difference = (b[index] ?? 0) - (a[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}

	return 0;
}

// Cette fonction liste les Ableton Live installes, la version la plus recente en tete.
//
// Windows installe Live dans `%ProgramData%\Ableton`, un dossier par edition : une Suite et une
// beta peuvent donc cohabiter. Chacune embarque son propre Max, et les deux ne sont pas forcement
// de la meme version : c'est pourquoi la version de Max est relevee par installation.
export function abletonInstalls() {
	const roots = [
		join(process.env.ProgramData ?? "C:\\ProgramData", "Ableton"),
		join(process.env.ProgramFiles ?? "C:\\Program Files", "Ableton"),
	];

	const installs = [];

	for (const root of roots) {
		if (!existsSync(root)) {
			continue;
		}

		for (const entry of readdirSync(root, { withFileTypes: true })) {
			// Un dossier commencant par un point est un reste de mise a jour qu'Ableton a mis de cote,
			// pas une installation utilisable : le compter ferait viser une version de Max abandonnee.
			if (!entry.isDirectory() || entry.name.startsWith(".")) {
				continue;
			}

			const folder = join(root, entry.name);
			const program = join(folder, "Program");
			if (!existsSync(program)) {
				continue;
			}

			const executable = readdirSync(program).find((name) => /^Ableton Live .*\.exe$/i.test(name));
			if (executable === undefined) {
				continue;
			}

			// Ableton livre Max dans ses ressources. C'est ce Max-la qui fait tourner le device, donc
			// c'est sa version qui designe la bibliotheque a servir, pas un Max installe a part.
			const maxExecutable = join(folder, "Resources", "Max", "Max.exe");
			const maxVersion = existsSync(maxExecutable) ? fileVersion(maxExecutable) : "";

			installs.push({
				name: entry.name,
				folder,
				version: fileVersion(join(program, executable)),
				maxVersion,
				// Le nom du dossier de bibliotheque ne retient que le numero majeur : Max 9.1.4
				// indexe `Documents\Max 9\Library`.
				maxMajor: maxVersion === "" ? 0 : versionOrder(maxVersion)[0],
			});
		}
	}

	return installs.sort(byVersionDescending);
}

// Cette fonction rend les versions majeures de Max a servir, la plus recente d'abord.
//
// Toutes les versions utilisees par un Ableton installe sont servies, pas seulement celle du plus
// recent : la copie ne coute rien, et elle evite que le device disparaisse quand Vassi ouvre l'autre
// Ableton. Si aucun Ableton n'est trouve, les dossiers deja crees par Max font foi.
export function maxMajorVersions(documents, installs) {
	const fromAbleton = installs.map((install) => install.maxMajor).filter((major) => major > 0);

	if (fromAbleton.length > 0) {
		return [...new Set(fromAbleton)].sort((a, b) => b - a);
	}

	const folders = [documents, join(process.env.APPDATA ?? "", "Cycling '74")];
	const found = new Set();

	for (const folder of folders) {
		if (!existsSync(folder)) {
			continue;
		}
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			const match = entry.isDirectory() ? entry.name.match(/^Max (\d+)$/) : null;
			if (match !== null) {
				found.add(Number.parseInt(match[1], 10));
			}
		}
	}

	return [...found].sort((a, b) => b - a);
}

// Cette fonction rend la bibliotheque utilisateur d'Ableton, celle que Live montre dans son
// navigateur sous Categories.
//
// Live la place par defaut dans `Documents\Ableton\User Library`. Un dossier deja rempli est le
// signe qu'on tient le bon : la presence de `Presets` distingue la vraie bibliotheque d'un dossier
// vide cree par erreur par une ancienne version de ce script.
export function abletonUserLibrary(documents) {
	const candidates = [documents];

	// Une machine passee sous OneDrive en cours de route peut garder l'ancienne bibliotheque hors
	// de OneDrive. Les deux emplacements sont donc regardes, et celui qui porte des presets gagne.
	if (process.env.USERPROFILE !== undefined) {
		candidates.push(join(process.env.USERPROFILE, "Documents"));
	}
	if (process.env.OneDrive !== undefined) {
		candidates.push(join(process.env.OneDrive, "Documents"));
	}

	const libraries = candidates.map((folder) => join(folder, "Ableton", "User Library"));

	const populated = libraries.find((library) => existsSync(join(library, "Presets")));
	if (populated !== undefined) {
		return populated;
	}

	return libraries[0];
}

// Cette fonction rassemble tout ce que l'installateur doit savoir : ou poser le `.amxd`, ou poser ce
// que Max doit retrouver par son nom, et ce qui traine d'une installation precedente mal placee.
export function resolveTargets() {
	const documents = documentsFolder();
	const installs = abletonInstalls();
	const majors = maxMajorVersions(documents, installs);

	const liveDevices = join(
		abletonUserLibrary(documents),
		"Presets",
		"Audio Effects",
		"Max Audio Effect",
		"Vassi Stream",
	);

	const maxPackages = majors.map((major) => ({
		major,
		folder: join(documents, `Max ${major}`, "Library", "Vassi Stream"),
	}));

	return { documents, installs, liveDevices, maxPackages, stale: stalePackages(documents, majors, liveDevices) };
}

// Cette fonction liste les depots laisses par une version precedente de l'installateur, aux
// endroits que ni Max ni Live ne lisent. Ils sont trompeurs : leur presence donne a croire que
// l'installation a reussi alors que le device ne trouvera rien.
//
// Seul un dossier `Vassi Stream` est signale, jamais son parent : `Documents\Max 8\Library` peut
// porter des paquets qui ne viennent pas de ce projet.
function stalePackages(documents, majors, liveDevices) {
	const roots = new Set();
	if (process.env.USERPROFILE !== undefined) {
		roots.add(join(process.env.USERPROFILE, "Documents"));
	}
	if (process.env.OneDrive !== undefined) {
		roots.add(join(process.env.OneDrive, "Documents"));
	}
	roots.add(documents);

	const stale = [];

	for (const root of roots) {
		if (!existsSync(root)) {
			continue;
		}

		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const match = entry.isDirectory() ? entry.name.match(/^Max (\d+)$/) : null;
			if (match === null) {
				continue;
			}

			const major = Number.parseInt(match[1], 10);
			const folder = join(root, entry.name, "Library", "Vassi Stream");

			// Un depot est perime s'il vise une version de Max qu'aucun Ableton n'utilise, ou s'il
			// est dans un `Documents` qui n'est pas celui du compte.
			const wanted = majors.includes(major) && root === documents;
			if (!wanted && existsSync(folder)) {
				stale.push(folder);
			}
		}

		// Le `.amxd` pose dans une bibliotheque Ableton qui n'est pas la bonne ne s'affiche nulle
		// part, et fait croire a une installation faite.
		const library = join(root, "Ableton", "User Library", "Presets", "Audio Effects", "Max Audio Effect", "Vassi Stream");
		if (library !== liveDevices && existsSync(library)) {
			stale.push(library);
		}

		// Le script Node pose a cote du `.amxd` : Max n'indexe pas la bibliotheque d'Ableton, donc
		// cette copie n'a jamais ete lue.
		const besideDevice = join(liveDevices, "node");
		if (existsSync(besideDevice) && !stale.includes(besideDevice)) {
			stale.push(besideDevice);
		}
	}

	return [...new Set(stale)];
}

// Lance directement, ce module montre ce qu'il a trouve. C'est le premier geste d'un depannage :
// il repond a « ou le device est-il sense atterrir sur cette machine ».
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const targets = resolveTargets();

	console.log(`Documents           ${targets.documents}`);
	console.log("");
	console.log("Ableton installes (le plus recent d'abord) :");
	if (targets.installs.length === 0) {
		console.log("  aucun trouve dans %ProgramData%\\Ableton");
	}
	for (const install of targets.installs) {
		console.log(`  ${install.name} — Live ${install.version}, Max ${install.maxVersion || "inconnu"}`);
	}
	console.log("");
	console.log(`Device (.amxd)      ${targets.liveDevices}`);
	for (const paquet of targets.maxPackages) {
		console.log(`Bibliotheque Max ${paquet.major}  ${paquet.folder}`);
	}
	if (targets.stale.length > 0) {
		console.log("");
		console.log("Depots perimes a effacer (rien ne les lit) :");
		for (const folder of targets.stale) {
			console.log(`  ${folder}`);
		}
	}
}
